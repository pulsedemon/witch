import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as files } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { parseCommand } from '../src/cli-control.js';
import { FamiliarReports } from '../src/familiar-run.js';
import { ControlHost } from '../src/persistence/control.js';
import type {
  ControlRequest,
  ControlOutcome,
} from '../src/persistence/control.js';
import { identifyProcess } from '../src/persistence/process.js';
import { compiledCli } from './fixtures/compiled-cli.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

async function fixture(
  mode = 'success',
  handle?: (request: ControlRequest) => Promise<ControlOutcome>,
  existing?: string,
) {
  const root = await scratch('witch-review-');

  await mkdir(join(root, 'bin'));

  await copyFile(
    fileURLToPath(new URL('./fixtures/claude-task.mjs', import.meta.url)),
    join(root, 'bin/claude'),
  );

  await chmod(join(root, 'bin/claude'), 0o700);

  if (existing) await writeFile(join(root, 'report.txt'), existing);

  const binding = {
    directory: join(root, 'control'),
    conversation: 'conversation',
    activation: randomUUID(),
  };

  const requests: ControlRequest[] = [];

  const errors: unknown[] = [];

  const host = await ControlHost.open(
    binding.directory,
    async (request) => {
      requests.push(request);

      if (handle) return handle(request);

      return {
        kind:
          request.action.kind === 'familiar-register'
            ? 'familiar-registered'
            : 'familiar-updated',
      };
    },
    (error) => errors.push(error),
  );

  const child = spawn(
    process.execPath,
    [
      await compiledCli(),
      '--control-dir',
      binding.directory,
      '--control-conversation',
      binding.conversation,
      '--control-activation',
      binding.activation,
      '--familiar-claude',
      'plan review',
      '--report-file',
      join(root, 'report.txt'),
      '--',
      '--model',
      'requested-alias',
      '--permission-prompts',
      'none',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        WITCH_FAMILIAR_FIXTURE: mode,
        WITCH_FAMILIAR_MARK: 'kept',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';

  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const closed = new Promise<number | null>((resolve) =>
    child.once('close', (code) => resolve(code)),
  );

  child.stdin.end('Read the supplied plan.');

  return {
    root,
    child,
    requests,
    closed,
    output: () => ({ stdout, stderr }),
    updates: () =>
      requests.flatMap((request) =>
        request.action.kind === 'familiar-update' ? [request.action] : [],
      ),
    ready: () =>
      until('native result before exit', () =>
        readFile(join(root, 'result-sent')).then(
          () => true,
          () => false,
        ),
      ),
    launch: async () =>
      JSON.parse(await readFile(join(root, 'launched.json'), 'utf8')) as {
        pid: number;
        argv: string[];
        prompt: string;
        mark: string;
        tmp: string;
      },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');

      await within(closed, 4000, 'wrapper cleanup');

      await host.close();

      assert.deepEqual(errors, []);
    },
  };
}

test('the wrapper retries a lost marker, preserves native inputs and saves every turn in a full report only after child exit', async () => {
  let registrations = 0;

  const f = await fixture('later-turn', async (request) => ({
    kind:
      request.action.kind === 'familiar-register'
        ? ++registrations === 1
          ? 'familiar-pending'
          : 'familiar-registered'
        : 'familiar-updated',
  }));

  try {
    await f.ready();

    assert.equal(
      f.updates().some((action) => action.progress.status !== 'running'),
      false,
    );

    const launch = await f.launch();

    assert.deepEqual(launch.argv, [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--settings',
      JSON.stringify({
        env: {
          CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
          CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
        },
      }),
      '--model',
      'requested-alias',
      '--permission-prompts',
      'none',
    ]);

    assert.equal(launch.prompt, 'Read the supplied plan.');

    assert.equal(launch.mark, 'kept');

    assert.equal(launch.tmp, process.env.TMPDIR);

    await writeFile(join(f.root, 'exit'), 'yes');

    assert.equal(await f.closed, 0, f.output().stderr);

    assert.equal(f.requests[0]!.deadline, f.requests[1]!.deadline);

    assert.deepEqual(f.requests[0]!.action, {
      kind: 'familiar-register',
      run: (f.requests[0]!.action as { run: string }).run,
      name: 'plan review',
      runtime: 'claude',
    });

    assert.equal(f.updates().at(-1)!.progress.model, 'claude-response');

    assert.equal(f.updates().at(-1)!.progress.tools, 2);

    assert.equal(f.updates().at(-1)!.progress.status, 'completed');

    const expected = `${'Full review.\n'.repeat(7000)}\n\nStopped the background search.`;

    assert.equal(await readFile(join(f.root, 'report.txt'), 'utf8'), expected);

    assert.equal((await stat(join(f.root, 'report.txt'))).mode & 0o777, 0o600);

    const markers = f
      .output()
      .stdout.split('\n')
      .filter((line) => line.startsWith('WITCH_FAMILIAR '));

    assert.equal(markers.length, 2);

    assert.equal(markers[0], markers[1]);

    assert.equal(
      f.output().stdout,
      `${markers.join('\n')}\n${expected}\n\nSaved report: ${join(f.root, 'report.txt')}\n`,
    );

    assert.equal(f.output().stderr, 'native stderr\n');

    assert.equal(await identifyProcess(launch.pid), undefined);
  } finally {
    await f.close();
  }
});

test('a timed-out accepted progress request retries its sequence and sends the terminal snapshot after it', async () => {
  let delayed = false;

  const f = await fixture('success', async (request) => {
    if (request.action.kind === 'familiar-register')
      return { kind: 'familiar-registered' };

    if (!delayed) {
      delayed = true;

      await delay(1800);
    }

    return { kind: 'familiar-updated' };
  });

  try {
    assert.equal(
      await within(f.closed, 5000, 'retry completion'),
      0,
      f.output().stderr,
    );

    const updates = f.updates();

    assert.deepEqual(
      updates.map((action) => action.sequence),
      [0, 0, 1],
    );

    assert.deepEqual(updates[0], updates[1]);

    assert.equal(updates[2]!.progress.status, 'completed');

    assert.equal(updates[2]!.progress.tools, 2);
  } finally {
    await f.close();
  }
});

test('SIGTERM escalates for an unresponsive child and reports stopped without accepting its early success result', async () => {
  const f = await fixture('ignore-term');

  try {
    await f.ready();

    const launch = await f.launch();

    f.child.kill('SIGTERM');

    assert.equal(await within(f.closed, 4000, 'signal escalation'), 130);

    assert.equal(f.updates().at(-1)!.progress.status, 'stopped');

    assert.match(f.updates().at(-1)!.progress.report!, /stopped \(SIGTERM\)/);

    assert.equal(await identifyProcess(launch.pid), undefined);
  } finally {
    await f.close();
  }
});

for (const kind of ['permission', 'malformed'] as const)
  test(`a retry wait crossing the deadline preserves the ${kind} reply failure`, async (t) => {
    const directory = await scratch('familiar-retry-deadline-');

    await mkdir(join(directory, 'inbox'));

    await mkdir(join(directory, 'replies'));

    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);

    const originalRead = files.readFile;

    let advance: ReturnType<typeof setTimeout> | undefined;

    t.onTestFinished(() => clearTimeout(advance));

    vi.spyOn(files, 'readFile').mockImplementation(
      async (...args: Parameters<typeof files.readFile>) => {
        if (!String(args[0]).startsWith(join(directory, 'replies')))
          return originalRead(...args);

        now.mockReturnValue(10_950);

        advance = setTimeout(() => now.mockReturnValue(11_001), 0);

        if (kind === 'permission')
          throw Object.assign(new Error('EACCES: reply unreadable'), {
            code: 'EACCES',
          });

        return '{\n';
      },
    );

    const failed = Promise.withResolvers<Error>();

    const reports = new FamiliarReports(
      { directory, conversation: 'owner', activation: randomUUID() },
      randomUUID(),
      failed.resolve,
    );

    reports.push({ status: 'running' });

    const error = await within(failed.promise, 3000, 'original reply failure');

    assert.match(
      error.message,
      kind === 'permission' ? /EACCES: reply unreadable/ : /JSON/,
    );

    assert.equal(reports.error, error);

    await assert.rejects(
      reports.finish({ status: 'completed', report: 'not delivered' }),
      (failure) => failure === error,
    );

    assert.equal((await files.readdir(join(directory, 'inbox'))).length, 1);
  });

test('an explicit reporting rejection stops its child and exits failed', async () => {
  const reject = Promise.withResolvers<void>();

  const f = await fixture('ignore-term', async (request) => {
    if (request.action.kind === 'familiar-register')
      return { kind: 'familiar-registered' };

    await reject.promise;

    return { kind: 'error', message: 'This native session closed.' };
  });

  try {
    await f.ready();

    const launch = await f.launch();

    reject.resolve();

    assert.equal(await within(f.closed, 4000, 'rejected reporter cleanup'), 1);

    assert.match(
      await readFile(join(f.root, 'report.txt'), 'utf8'),
      /Familiar reporting failed: This native session closed\./,
    );

    assert.equal(await identifyProcess(launch.pid), undefined);

    assert.equal(f.updates().length, 1);
  } finally {
    reject.resolve();

    await f.close();
  }
});

test('an error exit overrides a native success result', async () => {
  const f = await fixture('nonzero');

  try {
    assert.equal(await f.closed, 1);

    assert.equal(f.updates().at(-1)!.progress.status, 'failed');

    assert.match(
      f.updates().at(-1)!.progress.report!,
      /Claude exited with code 2\./,
    );
  } finally {
    await f.close();
  }
});

test('an exhausted progress timeout leaves the child running and delivers its final report after recovery', async () => {
  const gate = Promise.withResolvers<void>();

  const entered = Promise.withResolvers<void>();

  const f = await fixture('gated', async (request) => {
    if (request.action.kind === 'familiar-register')
      return { kind: 'familiar-registered' };

    entered.resolve();

    await gate.promise;

    return { kind: 'familiar-updated' };
  });

  try {
    await f.ready();

    const launch = await f.launch();

    const native = await identifyProcess(launch.pid);

    assert.ok(native);

    await within(entered.promise, 3000, 'stalled progress');

    await delay(11_000);

    assert.equal(f.child.exitCode, null);

    assert.deepEqual(await identifyProcess(launch.pid), native);

    await writeFile(join(f.root, 'exit'), 'yes');

    const expected = 'Full review.\n'.repeat(7000);

    await until(
      'final report saved during the outage',
      async () =>
        (await readFile(join(f.root, 'report.txt'), 'utf8')) === expected,
    );

    gate.resolve();

    assert.equal(
      await within(f.closed, 5000, 'recovered completion'),
      0,
      f.output().stderr,
    );

    assert.equal(await readFile(join(f.root, 'report.txt'), 'utf8'), expected);

    assert.equal(f.updates().at(-1)!.progress.status, 'completed');

    assert.equal(f.updates().at(-1)!.progress.report, expected);

    assert.equal(await identifyProcess(launch.pid), undefined);
  } finally {
    gate.resolve();

    await writeFile(join(f.root, 'exit'), 'yes');

    await f.close();
  }
});

test('an exhausted final report timeout retains the result and exits failed', async () => {
  const gate = Promise.withResolvers<void>();

  const f = await fixture('success', async (request) => {
    if (request.action.kind === 'familiar-register')
      return { kind: 'familiar-registered' };

    if (
      request.action.kind === 'familiar-update' &&
      request.action.progress.status !== 'running'
    )
      await gate.promise;

    return { kind: 'familiar-updated' };
  });

  try {
    assert.equal(await within(f.closed, 14_000, 'final delivery budget'), 1);

    const report = await readFile(join(f.root, 'report.txt'), 'utf8');

    assert.ok(report.startsWith('Full review.\n'.repeat(7000)));

    assert.match(
      report,
      /Familiar reporting failed: Coordination result unknown/,
    );

    assert.ok(
      f
        .output()
        .stdout.endsWith(
          `${report}\n\nSaved report: ${join(f.root, 'report.txt')}\n`,
        ),
    );

    assert.equal(await identifyProcess((await f.launch()).pid), undefined);
  } finally {
    gate.resolve();

    await f.close();
  }
});

test('a descendant retaining stdout cannot hold the wrapper open after the review child exits', async () => {
  const f = await fixture('held-pipe');

  let descendant: Awaited<ReturnType<typeof identifyProcess>>;

  try {
    assert.equal(await within(f.closed, 3000, 'bounded pipe drain'), 0);

    const pid = Number(await readFile(join(f.root, 'descendant.pid'), 'utf8'));

    descendant = await identifyProcess(pid);

    assert.ok(
      descendant,
      'the inherited pipe was still held when the wrapper completed',
    );

    assert.equal(f.updates().at(-1)!.progress.status, 'completed');
  } finally {
    if (
      descendant &&
      (await identifyProcess(descendant.pid))?.started === descendant.started
    ) {
      process.kill(descendant.pid, 'SIGKILL');

      await until(
        'fixture descendant cleanup',
        async () => !(await identifyProcess(descendant!.pid)),
      );
    }

    await f.close();
  }
});

for (const refusal of ['registration', 'existing report'] as const)
  test(`${refusal} prevents the native launch`, async () => {
    const f = await fixture(
      'success',
      async () => ({ kind: 'error', message: 'Stale activation.' }),
      refusal === 'existing report' ? 'Keep this report.' : undefined,
    );

    try {
      assert.equal(await f.closed, 1);

      await assert.rejects(readFile(join(f.root, 'launched.json')), {
        code: 'ENOENT',
      });

      if (refusal === 'existing report') {
        assert.deepEqual(f.requests, []);

        assert.equal(
          await readFile(join(f.root, 'report.txt'), 'utf8'),
          'Keep this report.',
        );
      } else assert.match(f.output().stderr, /Stale activation/);
    } finally {
      await f.close();
    }
  });

test('familiar CLI arguments reject mixed actions and conflicting native stream modes before launch', () => {
  const args = [
    '--control-dir',
    '/control',
    '--control-conversation',
    'a',
    '--control-activation',
    randomUUID(),
    '--familiar-claude',
    'review',
    '--report-file',
    '/report',
  ];

  for (const extra of [
    ['--peers', '--'],
    ['--continue', '--'],
    ['--', '--output-format=json'],
    ['--', '--input-format', 'stream-json'],
    ['--', '--remote-control'],
    // Witch's own settings keep the routed model from being remapped or swapped
    ['--', '--settings', '{}'],
    [],
  ])
    assert.throws(() => parseCommand([...args, ...extra]));

  assert.deepEqual(
    parseCommand([
      ...args,
      '--',
      '--model',
      'opus',
      '--permission-mode',
      'manual',
    ]).familiar?.args,
    ['--model', 'opus', '--permission-mode', 'manual'],
  );
});
