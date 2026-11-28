import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { FamiliarRun } from '../../src/agents/familiar-requests.js';
import { parseCommand } from '../../src/cli/cli-control.js';
import { ControlHost } from '../../src/persistence/control.js';
import { compiledCli } from '../fixtures/compiled-cli.js';
import { scratch } from '../fixtures/scratch.js';
import { appears } from '../fixtures/within.js';

const draft = '# Review probe\n\nCheck exact bytes.\n';

const planSha256 =
  '39b9102f8b41c703e0c017259f1c6096b6dc88ee9ead53eac4f39629647d6a65';

const finding = {
  file: 'plan.md',
  line: 3,
  blocking: true,
  summary: 'Missing proof',
  correction: 'Add a check',
};

const model = { claude: 'claude-response', codex: 'model-a' };

type Runtime = keyof typeof model;

function reviewArgs(runtime: Runtime, requested = model[runtime]) {
  return [
    `--familiar-${runtime}`,
    'plan review',
    '--report-file',
    'attempt.json',
    '--review-plan',
    'plan.md',
    '--review-brief',
    'brief.md',
    '--review-model',
    requested,
  ];
}

type Fault =
  | 'malformed'
  | 'edited'
  | 'stale'
  | 'model'
  | 'usage-limit'
  | 'rate-limit'
  | 'stopped'
  | 'lost-report'
  | 'lost-after-stage'
  | 'pending-report'
  | 'draft-after-save'
  | 'wrong-line'
  | 'missing-brief'
  | 'invalid-draft'
  | 'invalid-brief'
  | 'existing-receipt'
  | 'outside-draft'
  | 'checkout-input'
  | 'outside-cwd-input'
  | 'fifo'
  | 'large'
  | 'claude-empty-turn'
  | 'claude-unfinished-turn'
  | 'claude-denied'
  | 'claude-denied-then-result'
  | 'claude-rate-after'
  | 'question'
  | 'unknown-request'
  | 'stop-at-publication'
  | 'stop-at-check'
  | 'grow-on-read'
  | 'no-scope'
  | 'wrong-scratch'
  | 'outside-receipt'
  | 'aliased-receipt'
  | 'claude-started-turn'
  | 'malformed-question'
  | 'commentary-only'
  | 'missing-draft-and-reply';

async function stageInputs(
  root: string,
  draftFile: string,
  fault: Fault | undefined,
) {
  if (fault === 'fifo' || fault === 'existing-receipt') {
    execFileSync('mkfifo', [draftFile]);
  } else if (fault === 'outside-draft') {
    const external = join(await scratch('witch-outside-review-'), 'plan.md');
    await writeFile(external, draft);
    await symlink(external, draftFile);
  } else {
    await writeFile(
      draftFile,
      fault === 'invalid-draft'
        ? Buffer.from([0xff])
        : fault === 'large'
          ? Buffer.alloc(2 * 1024 * 1024 + 1, 'A')
          : fault === 'grow-on-read'
            ? Buffer.alloc(2 * 1024 * 1024, 'A')
            : draft,
    );
  }

  if (fault !== 'missing-brief' && fault !== 'existing-receipt')
    await writeFile(
      join(root, 'brief.md'),
      fault === 'invalid-brief'
        ? Buffer.from([0xff])
        : 'Use only the authorized files.\n',
    );

  if (fault === 'existing-receipt')
    await writeFile(join(root, 'attempt.json'), 'Earlier receipt.');
}

async function instrumentation(
  root: string,
  draftFile: string,
  fault: Fault | undefined,
) {
  if (!fault) return [];

  const script = join(root, 'probe.mjs');

  const source = new Map<Fault, readonly string[]>([
    ...(['stop-at-check', 'stop-at-publication'] as const).map(
      (name) =>
        [
          name,
          [
            "import { writeFileSync } from 'node:fs';",
            `process.on('SIGTERM', () => setImmediate(() => writeFileSync(${JSON.stringify(join(root, 'stop-observed'))}, 'yes')));`,
          ],
        ] as const,
    ),
    ...(
      ['lost-report', 'lost-after-stage', 'missing-draft-and-reply'] as const
    ).map(
      (name) =>
        [
          name,
          [
            "import { existsSync } from 'node:fs';",
            'const now = Date.now;',
            `Date.now = () => now() + (existsSync(${JSON.stringify(join(root, 'mail-timeout'))}) ? 31000 : 0);`,
          ],
        ] as const,
    ),
    [
      'draft-after-save',
      [
        "import { open, readFile, writeFile } from 'node:fs/promises';",
        `const handle = await open(${JSON.stringify(draftFile)});`,
        'const prototype = Object.getPrototypeOf(handle);',
        'const sync = prototype.sync;',
        'await handle.close();',
        'prototype.sync = async function () {',
        '  await sync.call(this);',
        `  if ((await readFile(${JSON.stringify(join(root, 'attempt.json'))}, 'utf8').catch(() => '')).includes('"status":"completed"')) {`,
        '    prototype.sync = sync;',
        `    await writeFile(${JSON.stringify(draftFile)}, 'Edited during receipt sync');`,
        '  }',
        '};',
      ],
    ],
    [
      'grow-on-read',
      [
        "import { open, appendFile } from 'node:fs/promises';",
        `const handle = await open(${JSON.stringify(draftFile)});`,
        'const prototype = Object.getPrototypeOf(handle);',
        'const read = prototype.read;',
        'await handle.close();',
        'prototype.read = async function (...args) {',
        '  prototype.read = read;',
        `  await appendFile(${JSON.stringify(draftFile)}, 'X');`,
        '  return read.apply(this, args);',
        '};',
      ],
    ],
  ]).get(fault);

  if (!source) return [];

  await writeFile(script, source.join('\n'));

  return ['--import', script];
}

async function launch(
  t: { onTestFinished: (cleanup: () => Promise<void>) => void },
  runtime: Runtime,
  fault?: Fault,
) {
  const root = await scratch('witch-plan-review-');
  const checkout = await scratch('witch-review-checkout-');

  const cwd =
    fault === 'checkout-input'
      ? join(checkout, 'nested')
      : fault === 'outside-cwd-input'
        ? await scratch('witch-review-caller-')
        : checkout;

  if (fault === 'checkout-input') {
    execFileSync('git', ['init', '--quiet', checkout]);
    await mkdir(cwd);
  }

  const native = join(root, runtime);

  const fixture = (name: string) =>
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

  if (runtime === 'codex') {
    for (const name of ['codex.mjs', 'codex-turns.mjs', 'peer-answer.mjs'])
      await copyFile(fixture(name), join(root, name));

    await writeFile(
      native,
      `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'codex.mjs')}" "$@"\n`,
    );
  } else {
    await copyFile(fixture('claude-task.mjs'), native);
  }

  await chmod(native, 0o700);

  const draftFile = join(
    fault === 'outside-cwd-input'
      ? cwd
      : fault === 'checkout-input'
        ? checkout
        : root,
    'plan.md',
  );

  await stageInputs(root, draftFile, fault);
  const preload = await instrumentation(root, draftFile, fault);

  if (fault === 'aliased-receipt')
    await symlink(checkout, join(root, 'receipt-link'));

  const receipt =
    fault === 'outside-receipt'
      ? join(checkout, 'attempt.json')
      : fault === 'aliased-receipt'
        ? join(root, 'receipt-link', 'attempt.json')
        : join(root, 'attempt.json');

  await writeFile(join(checkout, 'review-mode'), fault ?? 'ok');

  await writeFile(
    join(checkout, 'review-reply.txt'),
    fault === 'malformed'
      ? 'No structured findings.'
      : [
          '```json',
          JSON.stringify({
            findings: [
              fault === 'wrong-line' ? { ...finding, line: 999 } : finding,
            ],
          }),
          '```',
        ].join('\n'),
  );

  const activation = randomUUID();
  const control = join(root, 'control', 'familiars');
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const dropReply = Promise.withResolvers<void>();
  const forwarded: string[] = [];
  let familiar: FamiliarRun | undefined;

  const host = await ControlHost.open(
    control,
    async ({ action }) => {
      if (action.kind === 'familiar-register') {
        if (fault === 'stale')
          return { kind: 'error', message: 'Stale activation' };

        familiar = new FamiliarRun(action, () => {});

        if (!action.planReview || fault === 'no-scope')
          return { kind: 'familiar-registered' };

        return {
          kind: 'familiar-registered',
          reviewScope: {
            cwd: checkout,
            scratch: fault === 'wrong-scratch' ? checkout : root,
          },
        };
      }

      if (action.kind !== 'familiar-update') {
        forwarded.push(action.kind);

        return { kind: 'error', message: 'Unexpected plan reviewer request' };
      }

      const completed = action.progress.status === 'completed';

      if (
        (fault === 'lost-report' && completed) ||
        (fault === 'missing-draft-and-reply' &&
          action.progress.status === 'failed')
      ) {
        await writeFile(join(root, 'mail-timeout'), '');
        await dropReply.promise;

        return { kind: 'familiar-updated' };
      }

      if (
        ((fault === 'pending-report' ||
          fault === 'stop-at-check' ||
          fault === 'missing-draft-and-reply') &&
          action.progress.activity === 'Checking plan review receipt') ||
        (fault === 'stop-at-publication' && completed)
      ) {
        pending.resolve();
        await release.promise;
      }

      const reply = familiar!.report(action);

      if (fault === 'lost-after-stage' && completed) {
        await writeFile(join(root, 'mail-timeout'), '');
        await dropReply.promise;
      }

      return reply;
    },
    () => {},
  );

  t.onTestFinished(() => {
    release.resolve();
    dropReply.resolve();

    return host.close();
  });

  const requested =
    fault === 'model'
      ? 'other-model'
      : fault === 'claude-empty-turn'
        ? 'claude-observed'
        : model[runtime];

  const claudeMode =
    fault === 'claude-empty-turn'
      ? 'review-empty-turn'
      : fault === 'edited' || fault === 'stopped'
        ? 'gated'
        : (fault ?? 'success');

  const child = spawn(
    process.execPath,
    [
      ...preload,
      await compiledCli(),
      '--control-dir',
      control,
      '--control-conversation',
      'parent',
      '--control-activation',
      activation,
      ...reviewArgs(runtime, requested).map((arg) =>
        arg === 'plan.md'
          ? draftFile
          : arg === 'attempt.json'
            ? receipt
            : arg === 'brief.md'
              ? join(root, arg)
              : arg,
      ),
    ],
    {
      cwd,
      env: {
        ...process.env,
        [`WITCH_${runtime.toUpperCase()}_EXECUTABLE`]: native,
        WITCH_CODEX_FAMILIAR_FIXTURE: 'plan-review',
        WITCH_FAMILIAR_FIXTURE: claudeMode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let log = '';

  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      familiar?.end(
        code === 0 ? 'completed' : code === 130 ? 'stopped' : 'failed',
      );

      resolve(code);
    });
  });

  t.onTestFinished(async () => {
    if (child.exitCode === null) child.kill();

    await closed;
  });

  const outcome = async (code: number) => {
    assert.equal(await closed, code, log);

    return JSON.parse(await readFile(receipt, 'utf8'));
  };

  return {
    root,
    checkout,
    receipt,
    child,
    outcome,
    async output(code: number) {
      assert.equal(await closed, code, log);

      return log;
    },
    forwarded,
    status: () => familiar?.subagent.status,
    pending: pending.promise,
    release: release.resolve,
  };
}

for (const runtime of ['claude', 'codex'] as const) {
  test(`${runtime} reviews the frozen draft with read-only settings and reports validated findings`, async (t) => {
    const { checkout, outcome } = await launch(t, runtime);

    assert.deepEqual(await outcome(0), {
      planSha256,
      runtime,
      model: model[runtime],
      status: 'completed',
      findings: [finding],
    });

    const launched = JSON.parse(
      await readFile(join(checkout, 'launched.json'), 'utf8'),
    );

    let prompt: string;

    if (runtime === 'claude') {
      assert.equal(
        launched.argv[launched.argv.indexOf('--model') + 1],
        model[runtime],
      );

      assert.ok(launched.argv.includes('--strict-mcp-config'));
      assert.ok(launched.argv.includes('dontAsk'));

      assert.deepEqual(
        launched.argv.slice(
          launched.argv.indexOf('--tools') + 1,
          launched.argv.indexOf('--allowedTools'),
        ),
        ['Read', 'Grep', 'Glob'],
      );

      prompt = launched.prompt;
    } else {
      assert.ok(launched.argv.includes(`model="${model[runtime]}"`));
      assert.ok(launched.argv.includes('sandbox_mode="read-only"'));
      assert.ok(launched.argv.includes('approval_policy="never"'));
      assert.ok(launched.argv.includes('skills.include_instructions=false'));
      assert.ok(launched.argv.includes('features.hooks=false'));
      assert.ok(launched.argv.includes('notify=[]'));

      const turn = JSON.parse(
        await readFile(join(checkout, 'prompt.json'), 'utf8'),
      );

      prompt = turn.params.input[0].text;
    }

    assert.match(prompt, /Use only the authorized files/);
    assert.match(prompt, /asks the user for a decision/);
    assert.equal(prompt.split('Frozen plan draft:\n')[1], draft);
  });
}

for (const [fault, reason] of [
  ['malformed', /no closed json block/],
  ['stale', /Stale activation/],
  ['model', /expected other-model/],
  ['lost-report', /host did not reply before the deadline/],
  ['wrong-line', /outside the frozen plan/],
] as const) {
  test(`a ${fault} review leaves no completed receipt`, async (t) => {
    const { checkout, outcome } = await launch(t, 'codex', fault);
    const result = await outcome(1);
    assert.equal(result.planSha256, fault === 'stale' ? null : planSha256);
    assert.equal(result.status, 'failed');
    assert.equal(result.findings, undefined);
    assert.match(result.reason, reason);

    if (fault === 'stale')
      await assert.rejects(access(join(checkout, 'launched.json')), {
        code: 'ENOENT',
      });

    if (fault === 'model') {
      const launched = JSON.parse(
        await readFile(join(checkout, 'launched.json'), 'utf8'),
      );

      assert.ok(launched.argv.includes('model="other-model"'));
    }
  });
}

test('an unreadable brief leaves a failed receipt tied to the readable draft', async (t) => {
  const { checkout, outcome } = await launch(t, 'codex', 'missing-brief');
  const result = await outcome(1);
  assert.equal(result.planSha256, planSha256);
  assert.equal(result.model, null);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /brief\.md/);

  await assert.rejects(access(join(checkout, 'launched.json')), {
    code: 'ENOENT',
  });
});

test('an empty Claude result cannot borrow an earlier answer from a different model', async (t) => {
  const { outcome } = await launch(t, 'claude', 'claude-empty-turn');
  const result = await outcome(1);
  assert.equal(result.model, 'claude-observed');
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /no closed json block/);
});

for (const [fault, reason] of [
  ['invalid-draft', /must use UTF-8/],
  ['invalid-brief', /must use UTF-8/],
  ['outside-draft', /outside the allowed directories/],
  [
    'outside-cwd-input',
    /Launch the plan review from its admitted session directory/,
  ],
  ['fifo', /not a regular file/],
  ['large', /must fit within 2 MiB/],
  ['grow-on-read', /grew while being read/],
  ['no-scope', /did not authorize the plan review inputs/],
  ['wrong-scratch', /different review scratch directory/],
] as const) {
  test(`a ${fault} input fails before the reviewer starts`, async (t) => {
    const { checkout, outcome } = await launch(t, 'codex', fault);
    const result = await outcome(1);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, reason);

    await assert.rejects(access(join(checkout, 'launched.json')), {
      code: 'ENOENT',
    });
  });
}

test('an existing receipt refuses a new attempt before opening the inputs', async (t) => {
  const { root, output, status } = await launch(t, 'codex', 'existing-receipt');
  const log = await output(1);
  assert.match(log, /EEXIST:.*attempt\.json/);
  assert.equal(status(), undefined);

  assert.equal(
    await readFile(join(root, 'attempt.json'), 'utf8'),
    'Earlier receipt.',
  );
});

test('a nested caller can review a file in the admitted checkout root', async (t) => {
  const { checkout, outcome } = await launch(t, 'codex', 'checkout-input');
  assert.equal((await outcome(0)).planSha256, planSha256);
  await access(join(checkout, 'launched.json'));
});

for (const [runtime, fault] of [
  ['codex', 'outside-receipt'],
  ['claude', 'aliased-receipt'],
] as const) {
  test(`${runtime} refuses a ${fault} path beyond session scratch`, async (t) => {
    const { output, receipt } = await launch(t, runtime, fault);
    assert.match(await output(1), /receipt must be in session scratch/);
    await assert.rejects(access(receipt), { code: 'ENOENT' });
  });
}

for (const [fault, reason] of [
  ['claude-unfinished-turn', /final plan review turn returned/],
  ['claude-started-turn', /final plan review turn returned/],
  ['claude-denied', /Permission denied: Read .*plan\.md/],
  ['claude-denied-then-result', /Permission denied: Read .*plan\.md/],
] as const) {
  test(`${fault} prevents a Claude review from completing`, async (t) => {
    const { outcome, status } = await launch(t, 'claude', fault);
    const result = await outcome(1);
    assert.equal(result.status, 'failed');
    assert.equal(status(), result.status);
    assert.match(result.reason, reason);
  });
}

test('an unanswered Claude usage rejection invalidates the earlier plan review', async (t) => {
  const { outcome } = await launch(t, 'claude', 'claude-rate-after');
  const result = await outcome(1);
  assert.equal(result.status, 'failed');
  assert.equal(result.exhausted.window, '7D');
  assert.equal(result.findings, undefined);
});

for (const [fault, reason] of [
  ['question', /plan reviewer cannot request input/],
  ['unknown-request', /Unsupported native request: review\/unknown/],
  ['malformed-question', /could not read Codex's item\/completed questions/],
] as const) {
  test(`a Codex plan review surfaces ${fault} without forwarding a request`, async (t) => {
    const { outcome, forwarded } = await launch(t, 'codex', fault);
    const result = await outcome(1);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, reason);
    assert.deepEqual(forwarded, []);
  });
}

test('a draft change during the receipt check leaves Witch and the receipt failed', async (t) => {
  const { root, outcome, pending, release, status } = await launch(
    t,
    'codex',
    'pending-report',
  );

  await pending;
  assert.equal(status(), 'running');
  assert.equal(await readFile(join(root, 'attempt.json'), 'utf8'), '');
  await writeFile(join(root, 'plan.md'), 'Edited before publication');
  release();
  const result = await outcome(1);
  assert.equal(result.status, 'failed');
  assert.equal(status(), result.status);
  assert.match(result.reason, /plan draft changed/);
});

test('a missing draft at the receipt check leaves the reread error', async (t) => {
  const { root, outcome, pending, release } = await launch(
    t,
    'codex',
    'pending-report',
  );

  await pending;
  await unlink(join(root, 'plan.md'));
  release();
  const result = await outcome(1);
  assert.match(result.reason, /Could not reread the plan draft: ENOENT/);
});

test('a draft edit during receipt sync invalidates the staged findings', async (t) => {
  const { outcome, status } = await launch(t, 'codex', 'draft-after-save');
  const result = await outcome(1);
  assert.match(result.reason, /plan draft changed/);
  assert.equal(status(), 'failed');
  assert.equal(result.findings, undefined);
});

test('a lost reply after staging completion leaves Witch and the receipt failed', async (t) => {
  const { outcome, status } = await launch(t, 'codex', 'lost-after-stage');
  const result = await outcome(1);
  assert.match(result.reason, /host did not reply before the deadline/);
  assert.equal(result.status, 'failed');
  assert.equal(status(), 'failed');
});

test('a lost failure update retains the draft reread diagnostic', async (t) => {
  const { root, outcome, pending, release } = await launch(
    t,
    'codex',
    'missing-draft-and-reply',
  );

  await pending;
  await unlink(join(root, 'plan.md'));
  release();
  const result = await outcome(1);
  assert.match(result.reason, /Could not reread the plan draft: ENOENT/);
  assert.match(result.reason, /host did not reply before the deadline/);
});

test('Codex commentary cannot supply a completed review answer', async (t) => {
  const { outcome } = await launch(t, 'codex', 'commentary-only');
  const result = await outcome(1);
  assert.equal(result.status, 'failed');
  assert.equal(result.findings, undefined);
});

test('editing the submitted draft invalidates its review', async (t) => {
  const { root, checkout, outcome } = await launch(t, 'claude', 'edited');
  await appears(join(checkout, 'result-sent'));
  await writeFile(join(root, 'plan.md'), 'Changed draft');
  await writeFile(join(checkout, 'exit'), 'yes');
  const result = await outcome(1);
  assert.equal(result.planSha256, planSha256);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /plan draft changed/);
});

for (const runtime of ['claude', 'codex'] as const) {
  for (const fault of ['stop-at-check', 'stop-at-publication'] as const) {
    test(`${fault} leaves ${runtime}, Witch and the receipt stopped`, async (t) => {
      const { root, child, outcome, pending, release, status } = await launch(
        t,
        runtime,
        fault,
      );

      await pending;
      assert.equal(status(), 'running');
      assert.ok(child.kill('SIGTERM'));
      await appears(join(root, 'stop-observed'));
      release();
      const result = await outcome(130);
      assert.equal(result.status, 'stopped');
      assert.equal(status(), result.status);
      assert.equal(result.findings, undefined);
    });
  }
}

test('interrupting a reviewer with a draft answer leaves a stopped receipt', async (t) => {
  const { checkout, child, outcome } = await launch(t, 'claude', 'stopped');
  await appears(join(checkout, 'result-sent'));
  child.kill('SIGTERM');
  const result = await outcome(130);
  assert.equal(result.status, 'stopped');
  assert.equal(result.findings, undefined);
});

test('a usage refusal supplies exhaustion evidence and a rate limit does not', async (t) => {
  for (const [fault, exhausted] of [
    ['usage-limit', {}],
    ['rate-limit', undefined],
  ] as const) {
    const { outcome } = await launch(t, 'codex', fault);
    const result = await outcome(1);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.exhausted, exhausted);
  }
});

test('the review preset rejects native argument overrides before launch', () => {
  assert.throws(
    () =>
      parseCommand([
        ...reviewArgs('claude'),
        '--',
        '--dangerously-skip-permissions',
      ]),
    /Plan review supplies its own native arguments/,
  );
});

test('the review preset requires all three values and rejects a flag as a model ID', () => {
  const binding = [
    '--control-dir',
    'control',
    '--control-conversation',
    'parent',
    '--control-activation',
    randomUUID(),
  ];

  for (const option of ['--review-plan', '--review-brief', '--review-model']) {
    const args = reviewArgs('claude');
    args.splice(args.indexOf(option), 2);

    assert.throws(
      () => parseCommand([...binding, ...args]),
      /Plan review needs --review-plan/,
    );
  }

  assert.throws(
    () =>
      parseCommand([
        ...binding,
        ...reviewArgs('claude').slice(0, -2),
        '--review-model=--help',
      ]),
    /Plan review needs a routed model ID/,
  );
});
