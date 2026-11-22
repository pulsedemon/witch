import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { codexArguments } from '../../src/cli/cli-codex-familiar.js';
import { familiarMarker } from '../../src/agents/familiar-report.js';
import { parseCommand } from '../../src/cli/cli-control.js';
import type { UserResponse } from '../../src/agents/types.js';
import { ControlHost } from '../../src/persistence/control.js';
import type {
  ControlRequest,
  ControlOutcome,
} from '../../src/persistence/control.js';
import { identifyProcess } from '../../src/persistence/process.js';
import { compiledCli } from '../fixtures/compiled-cli.js';
import { scratch } from '../fixtures/scratch.js';
import { until, within } from '../fixtures/within.js';

async function fixture(
  options: {
    mode?: string;
    prompt?: string;
    openStdin?: boolean;
    pauseIntervals?: boolean;
    response?: UserResponse;
    waitForResponse?: boolean;
    reject?: boolean;
    existing?: boolean;
    withoutMcp?: boolean;
    config?: Record<string, unknown>;
    tools?: unknown[];
  } = {},
  beforeReply?: (request: ControlRequest) => Promise<void>,
) {
  const root = await scratch('codex-familiar-');
  const bin = join(root, 'bin');
  await mkdir(bin);

  for (const name of ['codex.mjs', 'codex-turns.mjs', 'peer-answer.mjs'])
    await copyFile(
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
      join(root, name),
    );

  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'codex.mjs')}' "$@"\n`,
  );

  await chmod(join(bin, 'codex'), 0o700);
  const report = join(root, 'report.txt');
  const preload: string[] = [];

  if (options.pauseIntervals) {
    const hook = join(root, 'pause-intervals.mjs');

    await writeFile(
      hook,
      `const interval = globalThis.setInterval;
globalThis.setInterval = (_callback, milliseconds) => interval(() => {}, milliseconds);
`,
    );

    preload.push('--import', hook);
  }

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

  if (options.config)
    await writeFile(join(root, 'config.json'), JSON.stringify(options.config));

  if (options.tools)
    await writeFile(
      join(root, 'answer-tools.json'),
      JSON.stringify(options.tools),
    );

  const binding = {
    directory: join(root, 'control'),
    conversation: 'owner',
    activation: randomUUID(),
  };

  const requests: ControlRequest[] = [];
  const errors: unknown[] = [];
  let rejectUpdates = false;

  let response = options.waitForResponse
    ? undefined
    : (options.response ?? { decision: 'accept' as const });

  const host = await ControlHost.open(
    binding.directory,
    async (request): Promise<ControlOutcome> => {
      requests.push(request);
      await beforeReply?.(request);

      switch (request.action.kind) {
        case 'familiar-register':
          return options.reject
            ? { kind: 'error', message: 'No active connection' }
            : { kind: 'familiar-registered' };

        case 'familiar-request':
          return { kind: 'familiar-request-pending' };

        case 'familiar-request-poll':
          return response
            ? { kind: 'familiar-response', response }
            : { kind: 'familiar-request-pending' };

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
      ...(options.withoutMcp ? ['--without-mcp'] : []),
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

  child.stdin.write(options.prompt ?? 'implement');

  if (!options.openStdin) child.stdin.end();

  const updates = () =>
    requests.flatMap((r) =>
      r.action.kind === 'familiar-update' ? [r.action.progress] : [],
    );

  return {
    root,
    binding,
    report,
    child,
    closed,
    requests,
    updates,
    answer: (value: UserResponse) => {
      response = value;
    },
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

test('a Codex familiar reports progress before stdin ends without waiting for a heartbeat', async () => {
  const f = await fixture({
    prompt: 'implement ',
    openStdin: true,
    pauseIntervals: true,
  });

  try {
    await until('progress while stdin remains open', () =>
      f.updates().some((progress) => progress.status === 'running'),
    );

    assert.equal(f.requests[0]!.action.kind, 'familiar-register');

    assert.equal(
      (f.requests[0]!.action as { runtime: string }).runtime,
      'codex',
    );

    assert.match(f.output().stdout, /WITCH_FAMILIAR /);
    assert.deepEqual(f.updates()[0], { status: 'running', tools: 0 });
    await assert.rejects(f.launch(), { code: 'ENOENT' });
    f.child.stdin.end('this');
    assert.equal(await within(f.closed, 8000, 'task after stdin ends'), 0);

    const delivered = JSON.parse(
      await readFile(join(f.root, 'prompt.json'), 'utf8'),
    ) as { params: { input: { text: string }[] } };

    assert.equal(delivered.params.input[0]!.text, 'implement this');
    assert.equal(f.updates().at(-1)!.status, 'completed');
  } finally {
    await f.close();
  }
});

for (const cause of ['signal', 'connection'] as const)
  test(`a Codex familiar waiting for stdin closes after ${cause} and saves its report`, async () => {
    const f = await fixture({ openStdin: true });

    try {
      await until('progress while stdin remains open', () =>
        f.updates().some((progress) => progress.status === 'running'),
      );

      if (cause === 'signal') f.child.kill('SIGTERM');
      else f.rejectUpdates();

      assert.equal(
        await within(f.closed, 7000, 'pending stdin cleanup'),
        cause === 'signal' ? 130 : 1,
      );

      await assert.rejects(f.launch(), { code: 'ENOENT' });
      const report = await readFile(f.report, 'utf8');

      if (cause === 'signal') {
        assert.equal(f.updates().at(-1)!.status, 'stopped');
        assert.equal(f.updates().at(-1)!.report, report);
      } else assert.match(report, /Native connection closed/);

      assert.ok(
        f.output().stdout.endsWith(`${report}\n\nSaved report: ${f.report}\n`),
      );
    } finally {
      await f.close();
    }
  });

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

test("a Codex familiar lists its spells before its turn and reports its own and its nested familiar's casts once each", async () => {
  const f = await fixture({ mode: 'spell-reads' });

  try {
    assert.equal(
      await within(f.closed, 8000, 'Codex completion'),
      0,
      f.output().stderr,
    );

    const methods = (await readFile(join(f.root, 'methods.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string);

    const listed = methods.indexOf('skills/list');

    assert.ok(
      listed >= 0 && listed < methods.indexOf('turn/start'),
      methods.join(),
    );

    const path = await realpath(join(f.root, '.agents/skills/a/SKILL.md'));
    const final = f.updates().at(-1)!;
    assert.equal(final.status, 'completed');

    assert.deepEqual(final.spells, [
      { id: `native-thread/turn-1/${path}`, name: 'a' },
      { id: `child-thread/child-turn-1/${path}`, name: 'a' },
    ]);
  } finally {
    await f.close();
  }
});

test('a Codex familiar relays only live bound command markers', async () => {
  const f = await fixture({ mode: 'nested-markers', openStdin: true });

  const marker = () => ({
    version: 1 as const,
    conversation: f.binding.conversation,
    activation: f.binding.activation,
    run: randomUUID(),
  });

  const valid = familiarMarker(marker());
  const recovered = familiarMarker(marker());
  const foreign = familiarMarker({ ...marker(), activation: randomUUID() });
  const noncommand = familiarMarker(marker());
  const discarded = familiarMarker(marker());

  try {
    await writeFile(
      join(f.root, 'marker-input.json'),
      JSON.stringify({ valid, recovered, foreign, noncommand, discarded }),
    );

    f.child.stdin.end();

    await until('bound markers before command completion', () =>
      f.output().stdout.includes(recovered),
    );

    assert.equal(f.output().stdout.split(valid).length - 1, 1);
    assert.equal(f.child.exitCode, null);
    assert.equal(f.output().stdout.includes('Saved report:'), false);
    assert.equal(f.output().stdout.includes('ordinary command output'), false);

    for (const ignored of [foreign, noncommand, discarded])
      assert.equal(f.output().stdout.includes(ignored), false);

    await writeFile(join(f.root, 'release'), 'finish');
    assert.equal(await within(f.closed, 8000, 'nested marker completion'), 0);

    for (const expected of [valid, recovered])
      assert.equal(
        f
          .output()
          .stdout.split('\n')
          .filter((line) => line === expected.trim()).length,
        1,
      );

    assert.equal(await readFile(f.report, 'utf8'), 'Nested markers finished.');
    assert.equal(f.updates().at(-1)!.status, 'completed');
    assert.equal(await identifyProcess((await f.launch()).pid), undefined);
  } finally {
    await f.close();
  }
});

test('a Codex familiar whose spell listing fails still runs its task', async () => {
  const f = await fixture({ mode: 'skills-fail' });

  try {
    assert.equal(
      await within(f.closed, 8000, 'Codex completion'),
      0,
      f.output().stderr,
    );

    assert.equal(f.updates().at(-1)!.status, 'completed');
  } finally {
    await f.close();
  }
});

test('declining the native approval prevents the requested write', async () => {
  const f = await fixture({ response: { decision: 'decline' } });

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

for (const when of ['after', 'during'] as const)
  test(`an async question answered ${when} the native turn reaches Codex before the familiar completes`, async () => {
    const f = await fixture({
      mode: `question-${when}`,
      waitForResponse: true,
    });

    try {
      await until('question forwarded', () =>
        f.requests.some(
          (request) => request.action.kind === 'familiar-request',
        ),
      );

      if (when === 'after')
        await until(
          'first turn report saved',
          async () => (await readFile(f.report, 'utf8')) === 'Which target?',
        );

      assert.equal(f.child.exitCode, null);

      assert.equal(
        f.updates().some((progress) => progress.status !== 'running'),
        false,
      );

      f.answer({ decision: 'accept', answers: { '0': ['preview'] } });
      assert.equal(await within(f.closed, 8000, 'answered task'), 0);

      const delivered = JSON.parse(
        await readFile(join(f.root, 'question-answer.json'), 'utf8'),
      ) as { method: string; params: { input: { text: string }[] } };

      assert.equal(
        delivered.method,
        when === 'after' ? 'turn/start' : 'turn/steer',
      );

      assert.equal(
        delivered.params.input[0]!.text,
        '**Which target?**\n→ preview',
      );

      const final = f.updates().at(-1)!;
      assert.equal(final.status, 'completed');
      assert.match(final.report!, /Which target\?[\s]+Implemented preview\./);
      assert.equal(await readFile(f.report, 'utf8'), 'Implemented preview.');
      assert.ok(f.output().stdout.includes(final.report!));

      assert.equal(
        f.requests.filter(
          (request) => request.action.kind === 'familiar-request-resolved',
        ).length,
        1,
      );
    } finally {
      await f.close();
    }
  });

for (const cause of ['cancel', 'signal', 'native-exit'] as const)
  test(`an unanswered async question does not prevent ${cause} cleanup`, async () => {
    const f = await fixture({
      mode: cause === 'native-exit' ? 'question-exit' : 'question-after',
      waitForResponse: true,
    });

    try {
      await f.ready();

      await until(
        'question turn ended',
        async () => (await readFile(f.report, 'utf8')) === 'Which target?',
      );

      const launch = await f.launch();

      if (cause === 'cancel') f.answer({ decision: 'cancel' });
      else if (cause === 'signal') f.child.kill('SIGTERM');
      else await writeFile(join(f.root, 'exit-question'), 'exit');

      assert.equal(
        await within(f.closed, 5000, 'pending question cleanup'),
        cause === 'native-exit' ? 1 : 130,
      );

      assert.equal(await identifyProcess(launch.pid), undefined);

      assert.equal(
        f.updates().at(-1)!.status,
        cause === 'native-exit' ? 'failed' : 'stopped',
      );

      if (cause === 'native-exit')
        assert.match(
          await readFile(f.report, 'utf8'),
          /awaiting a question response: question exit text/,
        );

      await assert.rejects(readFile(join(f.root, 'question-answer.json')), {
        code: 'ENOENT',
      });
    } finally {
      await f.close();
    }
  });

test('rejected registration and an existing report both prevent Codex from launching', async () => {
  for (const options of [
    { reject: true, openStdin: true },
    { existing: true },
  ]) {
    const f = await fixture(options);

    try {
      assert.equal(await within(f.closed, 5000, 'rejected launch'), 1);
      await assert.rejects(f.launch(), { code: 'ENOENT' });

      if ('existing' in options)
        assert.equal(await readFile(f.report, 'utf8'), 'Retain me');
      else
        assert.equal(await readFile(f.report, 'utf8'), 'No active connection');
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

test('a Codex familiar survives an exhausted progress timeout and delivers its pending final report', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let approvalResolved = false;

  const f = await fixture({ mode: 'gated-completion' }, async (request) => {
    if (request.action.kind === 'familiar-request-resolved')
      approvalResolved = true;

    if (
      approvalResolved &&
      request.action.kind === 'familiar-update' &&
      request.action.progress.status === 'running'
    ) {
      entered.resolve();
      await gate.promise;
    }
  });

  try {
    await within(entered.promise, 5000, 'stalled progress after approval');
    const launch = await f.launch();
    const native = await identifyProcess(launch.pid);
    assert.ok(native);
    await delay(32_000);
    assert.equal(f.child.exitCode, null);
    assert.deepEqual(await identifyProcess(launch.pid), native);
    await writeFile(join(f.root, 'release'), 'yes');
    const expected = 'Completed implementation.\n'.repeat(5000);

    await until(
      'final report saved during the outage',
      async () => (await readFile(f.report, 'utf8')) === expected,
    );

    gate.resolve();
    assert.equal(await within(f.closed, 5000, 'recovered completion'), 0);
    assert.equal(await readFile(f.report, 'utf8'), expected);
    assert.equal(f.updates().at(-1)!.status, 'completed');
    assert.equal(f.updates().at(-1)!.report, expected);
    assert.equal(await identifyProcess(launch.pid), undefined);
  } finally {
    gate.resolve();
    await writeFile(join(f.root, 'release'), 'yes');
    await f.close();
  }
});

test('a nonzero native exit after a result prevents successful terminal reporting', async () => {
  const f = await fixture({ mode: 'nonzero-close' });

  try {
    assert.equal(await within(f.closed, 8000, 'failed close'), 1);
    assert.equal(f.updates().at(-1)!.status, 'failed');
    const report = await readFile(f.report, 'utf8');
    assert.match(report, /^Completed implementation\./);
    assert.match(report, /Codex exited \(2\): close exit text/);
  } finally {
    await f.close();
  }
});

test('a Codex familiar posts a failed MCP server as a notice and keeps app-server logs off its stderr', async () => {
  const f = await fixture({ mode: 'mcp-failed' });

  try {
    assert.equal(
      await within(f.closed, 8000, 'Codex completion'),
      0,
      f.output().stderr,
    );

    assert.deepEqual(f.updates().at(-1)!.notices, [
      'Codex could not start MCP server unreal: MCP client for `unreal` failed to start: handshake failed',
      'Codex could not start MCP server auth.',
    ]);

    assert.doesNotMatch(f.output().stderr, /rmcp::transport::worker/);
  } finally {
    await f.close();
  }
});

test('an app-server that exits during startup leaves its stderr tail in the report', async () => {
  const f = await fixture({ mode: 'exit-on-init' });

  try {
    assert.equal(await within(f.closed, 5000, 'startup exit'), 1);
    const final = f.updates().at(-1)!;
    assert.equal(final.status, 'failed');
    assert.match(final.report!, /init exit text/);
    assert.match(await readFile(f.report, 'utf8'), /init exit text/);
    assert.match(f.output().stdout, /init exit text/);
    assert.doesNotMatch(f.output().stderr, /init exit text/);
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

  const claude = args.map((arg) =>
    arg === '--familiar-codex' ? '--familiar-claude' : arg,
  );

  assert.throws(() => parseCommand([...claude, '--without-mcp', '--']));
  assert.throws(() => parseCommand(['--without-mcp']));
});

test('a Codex familiar started --without-mcp disables every MCP source and refuses one Codex still exposes', async () => {
  const connect = async (root: string) =>
    (
      JSON.parse(await readFile(join(root, 'connect.json'), 'utf8')) as {
        params: { config: Record<string, unknown> };
      }
    ).params.config;

  const connected = [
    {
      name: 'unreal',
      authStatus: 'unsupported',
      runtimeStatus: 'connected',
      resources: [],
      resourceTemplates: [],
      tools: { write: { name: 'write', inputSchema: { type: 'object' } } },
    },
  ];

  const isolated = await fixture({
    withoutMcp: true,
    config: {
      mcp_servers: { unreal: { url: 'http://x' }, node_repl: { command: 'n' } },
    },
  });

  try {
    assert.equal(
      await within(isolated.closed, 8000, 'isolated completion'),
      0,
      isolated.output().stderr,
    );

    const config = await connect(isolated.root);
    assert.equal(config['features.apps'], false);
    assert.equal(config['features.plugins'], false);
    assert.equal(config['features.skill_mcp_dependency_install'], false);

    assert.deepEqual(config.mcp_servers, {
      unreal: { url: 'http://x', enabled: false },
      node_repl: { command: 'n', enabled: false },
    });

    assert.equal(config['features.hooks'], undefined);
  } finally {
    await isolated.close();
  }

  const ordinary = await fixture({
    config: { mcp_servers: { unreal: { url: 'http://x' } } },
    tools: connected,
  });

  try {
    assert.equal(
      await within(ordinary.closed, 8000, 'ordinary completion'),
      0,
      ordinary.output().stderr,
    );

    assert.equal((await connect(ordinary.root)).mcp_servers, undefined);
  } finally {
    await ordinary.close();
  }

  const exposed = await fixture({ withoutMcp: true, tools: connected });

  try {
    assert.equal(await within(exposed.closed, 8000, 'refused start'), 1);
    assert.deepEqual((await connect(exposed.root)).mcp_servers, {});

    assert.match(
      exposed.updates().at(-1)!.report!,
      /Codex exposed MCP tools to a familiar\./,
    );

    await assert.rejects(readFile(join(exposed.root, 'prompt.json')), {
      code: 'ENOENT',
    });
  } finally {
    await exposed.close();
  }
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
