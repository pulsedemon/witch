import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { writeJson } from '../src/persistence/json.js';
import { fileURLToPath } from 'node:url';
import { scratch } from './fixtures/scratch.js';
import { compiledCli } from './fixtures/compiled-cli.js';
import { readRecord } from './fixtures/coordinator.js';
import { exists, until, within } from './fixtures/within.js';
import { promisify, stripVTControlCharacters } from 'node:util';
import { StateStore } from '../src/persistence/store.js';
import { identifyProcess, sameProcess } from '../src/persistence/process.js';
import type { ProcessIdentity } from '../src/core/state.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const git = (
  await promisify(execFile)('/usr/bin/which', ['git'])
).stdout.trim();

async function check(
  runtime: 'codex' | 'claude',
  action: 'escape' | 'exit' | 'restart',
) {
  const root = await scratch(`witch-${runtime}-${action}-`);
  const cli = await compiledCli();
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const restartGate = join(root, 'restart');
  await mkdir(project, { recursive: true });
  await mkdir(bin);
  await symlink(git, join(bin, 'git'));
  const fixture = join(repo, `test/fixtures/${runtime}.mjs`);
  const mode = runtime === 'codex' ? 'brews' : 'background';
  await writeFile(
    join(bin, runtime),
    `#!/bin/sh\nexec '${process.execPath}' '${fixture}' '${mode}' ${runtime === 'codex' && action === 'exit' ? '--ignore-term' : ''} "$@"\n`,
    { mode: 0o755 },
  );
  const store = await StateStore.open(join(root, 'state'));
  const files = await store.create({
    id: 'shutdown',
    title: 'Shutdown',
    cwd: project,
    agent: runtime,
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
        WITCH_TEST_RESTART_GATE: action === 'restart' ? restartGate : undefined,
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
  const wait = (what: string, check: () => boolean | Promise<boolean>) =>
    until(
      what,
      async () => {
        assert.equal(
          child.exitCode ?? child.signalCode,
          null,
          `${what}: CLI exited; ${stderr}`,
        );
        return check();
      },
      600,
    ).catch((cause: unknown) => {
      throw new Error(
        `${what}: ${stripVTControlCharacters(output).slice(-8000)}\n${stderr}`,
        { cause },
      );
    });
  const submit = async (text: string) => {
    const start = output.length;
    child.stdin.write(text);
    await wait('composer', () =>
      stripVTControlCharacters(output.slice(start)).includes(text),
    );
    child.stdin.write('\r');
  };
  const input = async (text: string) => {
    const path = join(
      project,
      runtime === 'codex' ? 'prompt.json' : 'inputs.jsonl',
    );
    return readFile(path, 'utf8').then(
      (contents) => contents.includes(text),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
  };
  try {
    await wait('native connection', async () =>
      Boolean((await record()).process),
    );
    // snapshot storage sits in the state directory, since agents can write the scratch one
    assert.match((await readdir(join(store.root, 'changes'))).join(), /^\d+$/);
    const first = `shutdown-first-${randomUUID()}`;
    await submit(first);
    await wait('initial native input', () => input(first));
    const native = (await record()).process!;
    const start = performance.now();
    if (action === 'escape') child.stdin.write('\x1b');
    else await submit(`/${action}`);
    if (action === 'exit') {
      await within(closed, 11000, 'CLI exit');
      assert.equal(child.exitCode, 0, stderr);
      assert.deepEqual(await readdir(join(store.root, 'changes')), []);
    } else if (action === 'restart') {
      await wait('restart handoff', () => exists(restartGate));
    } else {
      await wait('interrupted turn', async () => {
        const current = await record();
        return current.lastTurn?.status === 'interrupted' && !current.activity;
      });
    }
    const elapsedMs = Math.round(performance.now() - start);
    assert.ok(elapsedMs < 10000, `${runtime} ${action}: ${elapsedMs} ms`);
    assert.equal(sameProcess(await identifyProcess(native.pid), native), false);
    const history = await readFile(
      join(store.root, 'conversations/shutdown/history.jsonl'),
      'utf8',
    );
    assert.match(history, /did not stop in time/);
    if (action === 'restart') {
      await writeFile(`${restartGate}.release`, '');
      await wait('replacement native connection', async () => {
        const current = await record();
        return !!current.process && !sameProcess(current.process, native);
      });
    }
    if (action !== 'exit') {
      const next = `shutdown-next-${randomUUID()}`;
      await submit(next);
      await wait('next native input', () => input(next));
      await writeJson(
        join(project, 'events-1.json'),
        runtime === 'codex'
          ? [
              {
                method: 'turn/completed',
                params: {
                  threadId: 'native-thread',
                  turn: { id: 'turn-1', status: 'completed', error: null },
                },
              },
            ]
          : [
              {
                type: 'system',
                subtype: 'session_state_changed',
                state: 'idle',
              },
            ],
      );
      await wait('next completed turn', async () => {
        const current = await record();
        return current.lastTurn?.status === 'completed' && !current.activity;
      });
      assert.equal((await record()).id, 'shutdown');
      const journal = await readFile(
        join(project, runtime === 'codex' ? 'prompts.jsonl' : 'inputs.jsonl'),
        'utf8',
      );
      assert.equal(
        journal.split('\n').filter((line) => line.includes(first)).length,
        1,
      );
      assert.equal(
        journal.split('\n').filter((line) => line.includes(next)).length,
        1,
      );
      await submit('/exit');
      await within(closed, 5000, 'final exit');
      assert.equal(child.exitCode, 0, stderr);
    }
  } finally {
    await record().catch(() => {});
    for (const identity of identities.values()) {
      if (sameProcess(await identifyProcess(identity.pid), identity))
        process.kill(identity.pid, 'SIGKILL');
    }
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
  }
}

for (const [runtime, action] of [
  ['codex', 'escape'],
  ['claude', 'escape'],
  ['codex', 'exit'],
  ['claude', 'exit'],
  ['claude', 'restart'],
] as const)
  test(`the compiled CLI completes ${runtime} ${action === 'restart' ? 'restart handoff' : action} within ten seconds after a stalled interrupt`, () =>
    check(runtime, action));
