import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
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
    | 'claude-empty-turn',
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
  await writeFile(join(root, 'plan.md'), draft);

  if (fault !== 'missing-brief')
    await writeFile(join(root, 'brief.md'), 'Use only the authorized files.\n');

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
  const control = join(root, 'control');
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const host = await ControlHost.open(
    control,
    async ({ action }) => {
      if (action.kind === 'familiar-register')
        return fault === 'stale'
          ? { kind: 'error', message: 'Stale activation' }
          : { kind: 'familiar-registered' };

      if (
        action.kind === 'familiar-update' &&
        action.progress.status === 'completed'
      ) {
        if (fault === 'lost-report')
          return {
            kind: 'error',
            message: 'The terminal report did not arrive',
          };

        if (fault === 'pending-report') {
          pending.resolve();
          await release.promise;
        }
      }

      return { kind: 'familiar-updated' };
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
        : 'success';

  const child = spawn(
    process.execPath,
    [
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
      assert.ok(launched.argv.includes('sandbox_mode="read-only"'));
      assert.ok(launched.argv.includes('approval_policy="never"'));
      assert.ok(launched.argv.includes('skills.include_instructions=false'));

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

test('the receipt waits for terminal acknowledgment and hashes the draft again', async (t) => {
  const { root, outcome, pending, release } = await launch(
    t,
    'codex',
    'pending-report',
  );

  await pending;
  assert.equal(await readFile(join(root, 'attempt.json'), 'utf8'), '');
  await writeFile(join(root, 'plan.md'), 'Edited after the terminal update');
  release();
  const result = await outcome(1);
  assert.equal(result.status, 'failed');
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

test('stopping a familiar during terminal acknowledgment leaves a stopped receipt', async (t) => {
  const { child, outcome, pending, release } = await launch(
    t,
    'claude',
    'pending-report',
  );

  await pending;
  assert.ok(child.kill('SIGTERM'));
  release();
  const result = await outcome(130);
  assert.equal(result.status, 'stopped');
  assert.equal(result.findings, undefined);
});

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
