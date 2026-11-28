import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  readFile,
  symlink,
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

async function launch(
  t: { onTestFinished: (cleanup: () => Promise<void>) => void },
  runtime: Runtime,
  fault?:
    | 'malformed'
    | 'edited'
    | 'stale'
    | 'model'
    | 'usage-limit'
    | 'rate-limit'
    | 'stopped'
    | 'lost-report'
    | 'pending-report'
    | 'wrong-line'
    | 'missing-brief'
    | 'invalid-draft'
    | 'invalid-brief'
    | 'existing-receipt'
    | 'outside-draft'
    | 'fifo'
    | 'large'
    | 'claude-empty-turn'
    | 'claude-unfinished-turn'
    | 'claude-denied'
    | 'question'
    | 'stop-at-check',
) {
  const root = await scratch('witch-plan-review-');
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
  const draftFile = join(root, 'plan.md');

  if (fault === 'fifo') {
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

  const signalProbe = join(root, 'signal.mjs');

  if (fault === 'stop-at-check')
    await writeFile(
      signalProbe,
      [
        "import { writeFileSync } from 'node:fs';",
        "process.on('SIGTERM', () => setImmediate(() => writeFileSync('stop-observed', 'yes')));",
      ].join('\n'),
    );

  await writeFile(join(root, 'review-mode'), fault ?? 'ok');

  await writeFile(
    join(root, 'review-reply.txt'),
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
  const forwarded: string[] = [];
  let familiar: FamiliarRun | undefined;

  const host = await ControlHost.open(
    control,
    async ({ action }) => {
      if (action.kind === 'familiar-register') {
        if (fault === 'stale')
          return { kind: 'error', message: 'Stale activation' };

        familiar = new FamiliarRun(action, () => {});

        return { kind: 'familiar-registered' };
      }

      if (action.kind !== 'familiar-update') {
        forwarded.push(action.kind);

        return { kind: 'error', message: 'Unexpected plan reviewer request' };
      }

      if (fault === 'lost-report' && action.progress.status === 'completed')
        return {
          kind: 'error',
          message: 'The terminal report did not arrive',
        };

      if (
        (fault === 'pending-report' || fault === 'stop-at-check') &&
        action.progress.activity === 'Checking plan review receipt'
      ) {
        pending.resolve();
        await release.promise;
      }

      return familiar!.report(action);
    },
    () => {},
  );

  t.onTestFinished(() => {
    release.resolve();

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
      ...(fault === 'stop-at-check' ? ['--import', signalProbe] : []),
      await compiledCli(),
      '--control-dir',
      control,
      '--control-conversation',
      'parent',
      '--control-activation',
      activation,
      ...reviewArgs(runtime, requested),
    ],
    {
      cwd: root,
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

  const closed = new Promise<number | null>((resolve) =>
    child.once('close', resolve),
  );

  t.onTestFinished(async () => {
    if (child.exitCode === null) child.kill();

    await closed;
  });

  const outcome = async (code: number) => {
    assert.equal(await closed, code, log);

    return JSON.parse(await readFile(join(root, 'attempt.json'), 'utf8'));
  };

  return {
    root,
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
    const { root, outcome } = await launch(t, runtime);

    assert.deepEqual(await outcome(0), {
      planSha256,
      runtime,
      model: model[runtime],
      status: 'completed',
      findings: [finding],
    });

    const launched = JSON.parse(
      await readFile(join(root, 'launched.json'), 'utf8'),
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
        await readFile(join(root, 'prompt.json'), 'utf8'),
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
  ['lost-report', /terminal report did not arrive/],
  ['wrong-line', /outside the frozen plan/],
] as const) {
  test(`a ${fault} review leaves no completed receipt`, async (t) => {
    const { root, outcome } = await launch(t, 'codex', fault);
    const result = await outcome(1);
    assert.equal(result.planSha256, planSha256);
    assert.equal(result.status, 'failed');
    assert.equal(result.findings, undefined);
    assert.match(result.reason, reason);

    if (fault === 'stale')
      await assert.rejects(access(join(root, 'launched.json')), {
        code: 'ENOENT',
      });

    if (fault === 'model') {
      const launched = JSON.parse(
        await readFile(join(root, 'launched.json'), 'utf8'),
      );

      assert.ok(launched.argv.includes('model="other-model"'));
    }
  });
}

test('an unreadable brief leaves a failed receipt tied to the readable draft', async (t) => {
  const { root, outcome } = await launch(t, 'codex', 'missing-brief');
  const result = await outcome(1);
  assert.equal(result.planSha256, planSha256);
  assert.equal(result.model, null);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /brief\.md/);
  await assert.rejects(access(join(root, 'launched.json')), { code: 'ENOENT' });
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
  ['fifo', /not a regular file/],
  ['large', /must fit within 2 MiB/],
] as const) {
  test(`a ${fault} input fails before the reviewer starts`, async (t) => {
    const { root, outcome } = await launch(t, 'codex', fault);
    const result = await outcome(1);
    assert.equal(result.status, 'failed');
    assert.match(result.reason, reason);

    await assert.rejects(access(join(root, 'launched.json')), {
      code: 'ENOENT',
    });
  });
}

test('a receipt write refusal keeps the input diagnostic and the previous receipt', async (t) => {
  const { root, output } = await launch(t, 'codex', 'existing-receipt');
  const log = await output(1);
  assert.match(log, /ENOENT:.*brief\.md/);
  assert.match(log, /Could not save the receipt: EEXIST/);

  assert.equal(
    await readFile(join(root, 'attempt.json'), 'utf8'),
    'Earlier receipt.',
  );
});

for (const [fault, reason] of [
  ['claude-unfinished-turn', /final plan review turn returned/],
  ['claude-denied', /Permission denied: Read .*plan\.md/],
] as const) {
  test(`${fault} prevents a Claude review from completing`, async (t) => {
    const { outcome, status } = await launch(t, 'claude', fault);
    const result = await outcome(1);
    assert.equal(result.status, 'failed');
    assert.equal(status(), result.status);
    assert.match(result.reason, reason);
  });
}

test('a Codex plan review fails without forwarding its native question', async (t) => {
  const { outcome, forwarded } = await launch(t, 'codex', 'question');
  const result = await outcome(1);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /plan reviewer cannot request input/);
  assert.deepEqual(forwarded, []);
});

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

test('editing the submitted draft invalidates its review', async (t) => {
  const { root, outcome } = await launch(t, 'claude', 'edited');
  await appears(join(root, 'result-sent'));
  await writeFile(join(root, 'plan.md'), 'Changed draft');
  await writeFile(join(root, 'exit'), 'yes');
  const result = await outcome(1);
  assert.equal(result.planSha256, planSha256);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /plan draft changed/);
});

for (const runtime of ['claude', 'codex'] as const) {
  test(`stopping ${runtime} during the receipt check leaves Witch and the receipt stopped`, async (t) => {
    const { root, child, outcome, pending, release, status } = await launch(
      t,
      runtime,
      'stop-at-check',
    );

    await pending;
    assert.ok(child.kill('SIGTERM'));
    await appears(join(root, 'stop-observed'));
    release();
    const result = await outcome(130);
    assert.equal(result.status, 'stopped');
    assert.equal(status(), result.status);
    assert.equal(result.findings, undefined);
  });
}

test('interrupting a reviewer with a draft answer leaves a stopped receipt', async (t) => {
  const { root, child, outcome } = await launch(t, 'claude', 'stopped');
  await appears(join(root, 'result-sent'));
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
