import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { codexArguments } from '../src/cli-codex-familiar.js';
import { parseCommand } from '../src/cli-control.js';
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
  options: {
    mode?: string;
    prompt?: string;
    decision?: 'accept' | 'decline' | 'cancel';
    reject?: boolean;
    existing?: boolean;
  } = {},
) {
  const root = await scratch('codex-familiar-');
  const bin = join(root, 'bin');
  await mkdir(bin);
  await copyFile(
    fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
    join(root, 'codex.mjs'),
  );
  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'codex.mjs')}' "$@"\n`,
  );
  await chmod(join(bin, 'codex'), 0o700);
  const report = join(root, 'report.txt');
  const preload: string[] = [];
  if (options.mode === 'write-failure') {
    const hook = join(root, 'fail-write.mjs');
    await writeFile(
      hook,
      `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.open;
fs.open = async (...args) => {
  const file = await open(...args);
  if (args[0] === ${JSON.stringify(report)})
    file.write = async () => { throw Object.assign(new Error('Report write failed: ENOSPC'), { code: 'ENOSPC' }); };
  return file;
};
syncBuiltinESMExports();
`,
    );
    preload.push('--import', hook);
  }
  if (options.existing) await writeFile(report, 'Retain me');
  const binding = {
    directory: join(root, 'control'),
    conversation: 'owner',
    activation: randomUUID(),
  };
  const requests: ControlRequest[] = [];
  const errors: unknown[] = [];
  let rejectUpdates = false;
  const host = await ControlHost.open(
    binding.directory,
    async (request): Promise<ControlOutcome> => {
      requests.push(request);
      switch (request.action.kind) {
        case 'familiar-register':
          return options.reject
            ? { kind: 'error', message: 'No active connection' }
            : { kind: 'familiar-registered' };
        case 'familiar-request':
          return { kind: 'familiar-request-pending' };
        case 'familiar-request-poll':
          return {
            kind: 'familiar-response',
            response: { decision: options.decision ?? 'accept' },
          };
        case 'familiar-update':
          return rejectUpdates
            ? { kind: 'error', message: 'Native connection closed' }
            : { kind: 'familiar-updated' };
        default:
          return { kind: 'familiar-updated' };
      }
    },
    (error) => errors.push(error),
  );
  const child = spawn(
    process.execPath,
    [
      ...preload,
      await compiledCli(),
      '--control-dir',
      binding.directory,
      '--control-conversation',
      binding.conversation,
      '--control-activation',
      binding.activation,
      '--familiar-codex',
      'implementation',
      '--report-file',
      report,
      '--',
      '-c',
      'model="requested-alias"',
      '-c',
      'approval_policy="on-request"',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WITCH_CODEX_FAMILIAR_FIXTURE: options.mode ?? 'success',
        WITCH_JOBS: 'owned-mark',
      },
      stdio: 'pipe',
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );
  child.stdin.end(options.prompt ?? 'implement');
  const updates = () =>
    requests.flatMap((r) =>
      r.action.kind === 'familiar-update' ? [r.action.progress] : [],
    );
  return {
    root,
    report,
    child,
    closed,
    requests,
    updates,
    output: () => ({ stdout, stderr }),
    rejectUpdates: () => {
      rejectUpdates = true;
    },
    launch: async () =>
      JSON.parse(await readFile(join(root, 'launched.json'), 'utf8')) as {
        pid: number;
        argv: string[];
        mark: string;
      },
    ready: () =>
      until(
        'Codex turn and initial report',
        async () =>
          (await readFile(join(root, 'prompt.json')).then(
            () => true,
            () => false,
          )) && updates().length > 0,
      ),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      await within(closed, 5000, 'Codex wrapper cleanup');
      await host.close();
      assert.deepEqual(errors, []);
    },
  };
}

test('a Codex implementation task retains native configuration, approval and its full report', async () => {
  const f = await fixture();
  try {
    assert.equal(
      await within(f.closed, 8000, 'Codex completion'),
      0,
      f.output().stderr,
    );
    assert.equal(
      await readFile(join(f.root, 'approved.txt'), 'utf8'),
      'approved',
    );
    const launch = await f.launch();
    assert.deepEqual(launch.argv, [
      'app-server',
      '--stdio',
      '-c',
      'model="requested-alias"',
      '-c',
      'approval_policy="on-request"',
    ]);
    assert.equal(launch.mark, 'owned-mark');
    assert.equal(await identifyProcess(launch.pid), undefined);
    const final = f.updates().at(-1)!;
    assert.equal(final.status, 'completed');
    assert.equal(final.model, 'observed-codex');
    assert.equal(final.tools, 2);
    const expected = 'Completed implementation.\n'.repeat(5000);
    assert.equal(await readFile(f.report, 'utf8'), expected);
    assert.equal(final.report, expected);
    assert.match(f.output().stdout, /Saved report:/);
    assert.equal(
      f.requests.filter((r) => r.action.kind === 'familiar-request').length,
      1,
    );
    assert.equal(
      f.requests.filter((r) => r.action.kind === 'familiar-request-resolved')
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('declining the native approval prevents the requested write', async () => {
  const f = await fixture({ decision: 'decline' });
  try {
    assert.equal(await within(f.closed, 8000, 'declined task'), 0);
    await assert.rejects(readFile(join(f.root, 'approved.txt')), {
      code: 'ENOENT',
    });
    assert.equal(f.updates().at(-1)!.status, 'completed');
  } finally {
    await f.close();
  }
});

test('rejected registration and an existing report both prevent Codex from launching', async () => {
  for (const options of [{ reject: true }, { existing: true }]) {
    const f = await fixture(options);
    try {
      assert.equal(await within(f.closed, 5000, 'rejected launch'), 1);
      await assert.rejects(f.launch(), { code: 'ENOENT' });
      if ('existing' in options)
        assert.equal(await readFile(f.report, 'utf8'), 'Retain me');
    } finally {
      await f.close();
    }
  }
});

test('a silent Codex task stops on interruption or loss of its reporting connection', async () => {
  for (const cause of ['signal', 'connection'] as const) {
    const f = await fixture({ prompt: 'hold' });
    try {
      await f.ready();
      const launch = await f.launch();
      if (cause === 'signal') f.child.kill('SIGTERM');
      else f.rejectUpdates();
      assert.equal(
        await within(f.closed, 7000, 'silent task cleanup'),
        cause === 'signal' ? 130 : 1,
      );
      assert.equal(await identifyProcess(launch.pid), undefined);
      if (cause === 'signal')
        assert.equal(f.updates().at(-1)!.status, 'stopped');
      else
        assert.match(
          await readFile(f.report, 'utf8'),
          /Native connection closed/,
        );
    } finally {
      await f.close();
    }
  }
});

test('a nonzero native exit after a result prevents successful terminal reporting', async () => {
  const f = await fixture({ mode: 'nonzero-close' });
  try {
    assert.equal(await within(f.closed, 8000, 'failed close'), 1);
    assert.equal(f.updates().at(-1)!.status, 'failed');
    const report = await readFile(f.report, 'utf8');
    assert.match(report, /^Completed implementation\./);
    assert.match(report, /Codex exited \(2\)/);
  } finally {
    await f.close();
  }
});

test('Codex familiar arguments keep configuration but reject a different transport or command', () => {
  assert.deepEqual(
    codexArguments([
      '--config=model="gpt-6-astra"',
      '--enable',
      'multi_agent',
      '--strict-config',
    ]),
    [
      'app-server',
      '--stdio',
      '--config=model="gpt-6-astra"',
      '--enable',
      'multi_agent',
      '--strict-config',
    ],
  );
  for (const args of [
    ['--listen', 'off'],
    ['--stdio'],
    ['daemon'],
    ['--help'],
    ['--version'],
    ['-c'],
  ])
    assert.throws(() => codexArguments(args));
  const args = [
    '--control-dir',
    '/control',
    '--control-conversation',
    'owner',
    '--control-activation',
    randomUUID(),
    '--familiar-codex',
    'implement',
    '--report-file',
    '/new-report',
  ];
  assert.equal(
    parseCommand([...args, '--', '-c', 'model="gpt-6-astra"']).familiar!
      .runtime,
    'codex',
  );
  assert.throws(() =>
    parseCommand([...args, '--familiar-claude', 'other', '--']),
  );
});

test('a failed report write cannot publish success', async () => {
  const f = await fixture({ mode: 'write-failure' });
  try {
    assert.equal(await within(f.closed, 8000, 'report write failure'), 1);
    assert.equal(
      f.updates().some((progress) => progress.status === 'completed'),
      false,
    );
    assert.match(f.output().stderr, /Report write failed: ENOSPC/);
  } finally {
    await f.close();
  }
});
