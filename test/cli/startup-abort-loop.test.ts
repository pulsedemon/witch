import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { test } from 'vitest';
import { identifyProcess, sameProcess } from '../../src/persistence/process.js';
import { StateStore } from '../../src/persistence/store.js';
import { compiledCli } from '../fixtures/compiled-cli.js';
import { readRecord } from '../fixtures/coordinator.js';
import { scratch } from '../fixtures/scratch.js';
import { within } from '../fixtures/within.js';
import type { ProcessIdentity } from '../../src/core/state.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));

const git = (
  await promisify(execFile)('/usr/bin/which', ['git'])
).stdout.trim();

const duration = Number(process.env.STARTUP_LOOP_MS ?? 600_000);
const lanes = 8;

type Outcome =
  | { kind: 'registered' }
  | {
      kind: 'exit' | 'stall';
      pid: number | undefined;
      signal: NodeJS.Signals | null;
      code: number | null;
      stderr: string;
      frame: string;
    };

/** one start of the compiled CLI on the codex fixture, set up as cli-shutdown.test.ts does. */
async function startup(cli: string): Promise<Outcome> {
  const root = await scratch('witch-startup-loop-');
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(project, { recursive: true });
  await mkdir(bin);
  await symlink(git, join(bin, 'git'));
  const fixture = join(repo, 'test/fixtures/codex.mjs');

  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec '${process.execPath}' '${fixture}' 'brews'  "$@"\n`,
    { mode: 0o755 },
  );

  const store = await StateStore.open(join(root, 'state'));

  const files = await store.create({
    id: 'shutdown',
    title: 'Shutdown',
    cwd: project,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  });

  await files.close();
  await writeFile(join(project, 'hold-interrupt'), '');

  const child = spawn(
    process.execPath,
    [
      '--import',
      join(repo, 'test/fixtures/cli-terminal.mjs'),
      cli,
      '--state-dir',
      store.root,
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        WITCH_CONVERSATION: 'shutdown',
        WITCH_SCRATCH: undefined,
        WITCH_JOBS_RESUME: undefined,
        WITCH_JOBS: undefined,
        WITCH_CODEX_FAMILIAR_FIXTURE: undefined,
        WITCH_TEST_RESTART_GATE: undefined,
        NODE_TEST_CONTEXT: undefined,
        NO_COLOR: undefined,
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        CI: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const closed = once(child, 'close');
  void closed.catch(() => {});
  let output = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const identities = new Map<number, ProcessIdentity>();

  const record = async () => {
    const value = await readRecord(root, 'shutdown');

    for (const identity of [value.process, value.usageProcess])
      if (identity) identities.set(identity.pid, identity);

    return value;
  };

  const failed = (kind: 'exit' | 'stall'): Outcome => ({
    kind,
    pid: child.pid,
    signal: child.signalCode,
    code: child.exitCode,
    stderr,
    frame: stripVTControlCharacters(output).slice(-2000),
  });

  try {
    const deadline = performance.now() + 30_000;

    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        await within(closed, 5000, 'CLI close').catch(() => {});

        return failed('exit');
      }

      if ((await record()).process) return { kind: 'registered' };

      await delay(20);
    }

    return failed('stall');
  } finally {
    await record().catch(() => {});

    for (const identity of identities.values()) {
      if (sameProcess(await identifyProcess(identity.pid), identity))
        try {
          process.kill(identity.pid, 'SIGKILL');
        } catch {
          // it exited between the identity check and the signal
        }
    }

    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    await within(closed, 5000, 'CLI close');
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

test(
  'the compiled CLI reaches native-process registration on every start',
  { timeout: 14 * 60_000 },
  async () => {
    if (process.platform === 'linux')
      assert.match(
        await readFile('/proc/self/limits', 'utf8'),
        /^Max core file size\s+unlimited/m,
      );

    const cli = await compiledCli();
    const end = performance.now() + duration;
    const failures: Outcome[] = [];
    let stop = false;
    let total = 0;

    const settled = await Promise.allSettled(
      Array.from({ length: lanes }, async (_, lane) => {
        let count = 0;

        try {
          while (!stop && performance.now() < end) {
            const outcome = await startup(cli);

            if (outcome.kind === 'registered') {
              count++;
            } else {
              stop = true;
              failures.push(outcome);
            }
          }
        } catch (error) {
          stop = true;

          throw error;
        } finally {
          total += count;
          console.log(`lane ${lane}: ${count} startups registered`);
        }
      }),
    );

    console.log(`total: ${total} startups registered`);

    const errors = settled.flatMap((lane) =>
      lane.status === 'rejected' ? [lane.reason as unknown] : [],
    );

    assert.deepEqual({ failures, errors }, { failures: [], errors: [] });
  },
);
