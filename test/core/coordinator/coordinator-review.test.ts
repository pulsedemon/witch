import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { NativeStop, NativeStopTimeout } from '../../../src/agents/shutdown.js';
import type { Usage } from '../../../src/agents/types.js';
import type { ControlOutcome } from '../../../src/persistence/control.js';
import { router } from '../../../src/core/runtime/router.js';
import type { Demand } from '../../../src/core/runtime/demand.js';
import type {
  Reviewer,
  ReviewerResult,
} from '../../../src/core/review/reviewers.js';
import type { Routed } from '../../../src/core/runtime/routing.js';
import { main } from '../../../src/memory/names.js';
import { Workspace } from '../../../src/memory/workspace.js';
import { ConversationStore } from '../../../src/persistence/store.js';
import { CommandBatches } from '../../../src/ui/commands/command-batches.js';
import type { WitchCommand } from '../../../src/ui/commands/commands.js';
import { FixtureAgent, TurnGate } from '../../fixtures/agent.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import {
  coordinationFixture,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import { png } from '../../fixtures/png.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

const claudeRoute: Routed = {
  runtime: 'claude',
  model: 'claude-opus-5-5',
  reason: 'test',
};

const codexRoute: Routed = {
  runtime: 'codex',
  model: 'gpt-6.1-sol',
  reason: 'test',
};

interface Finding {
  line: number;
  blocking: boolean;
  summary?: string;
}

/** what one scripted reviewer reports. */
interface Outcome {
  findings?: Finding[];
  /** null for a reviewer that never registered. */
  status?: ReviewerResult['status'] | null;
  diagnostics?: string;
  code?: number | null;
  model?: string;
  report?: string;
}

const target = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
/** the runtime a reviewer's name carries, as `review-<run>-<round>-<runtime>`. */
const runtimeOf = ({ name }: Reviewer) => name.split('-')[3]!;

async function harness(
  t: TestContext,
  options: { usage?: Usage; plan?: string } = {},
  createFixture = unitCoordinationFixture,
) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = await scratch('witch-review-tmp-');

  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });

  const f = await createFixture(orderedCleanup(t.onTestFinished));
  const claude = new FixtureAgent('claude');
  const codex = new FixtureAgent('codex');

  if (options.usage) claude.connectUsage = options.usage;

  const { coordinator, coordination } = await f.start(
    'A',
    {},
    [claude, codex].map((adapter) => ({ adapter, executable: adapter.id })),
  );

  const cwd = coordinator.snapshot.conversation!.cwd;
  const plan = join(cwd, 'plan.md');
  await writeFile(plan, options.plan ?? `${target.join('\n')}\n`);
  const lines = async () => (await readFile(plan, 'utf8')).split('\n');

  const setLines = async (edits: Record<number, string>) => {
    const text = await lines();

    for (const [line, value] of Object.entries(edits))
      text[Number(line) - 1] = value;

    await writeFile(plan, text.join('\n'));
  };

  const actions: unknown[] = [];

  const state: {
    routes: (round: number) => Routed[];
    outcome: (round: number, reviewer: { runtime: string }) => Outcome;
    /** a round's reviewers wait for this before reporting, when set. */
    hold?: Promise<void>;
    during?: () => Promise<void>;
  } = {
    routes: () => [claudeRoute, codexRoute],
    outcome: () => ({}),
  };

  coordination.router = async (action) => {
    actions.push(action);

    return { kind: 'route', routes: state.routes(actions.length) };
  };

  const rounds: {
    reviewers: Reviewer[];
    brief: string;
    signal: AbortSignal;
  }[] = [];

  coordinator.reviewers.run = async ({ reviewers, signal }) => {
    const briefFile = /< '([^']+)'$/.exec(reviewers[0]!.command)![1]!;

    rounds.push({
      reviewers: [...reviewers],
      brief: await readFile(briefFile, 'utf8'),
      signal,
    });

    await state.during?.();
    await state.hold;

    return reviewers.map((reviewer) => {
      const outcome = state.outcome(rounds.length, {
        runtime: runtimeOf(reviewer),
      });

      const model = /'--model' '([^']+)'|'model="([^"]+)"'/.exec(
        reviewer.command,
      )!;

      return {
        code: outcome.code === undefined ? 0 : outcome.code,
        ...(outcome.status === null
          ? {}
          : { status: outcome.status ?? 'completed' }),
        ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics } : {}),
        model: outcome.model ?? model[1] ?? model[2]!,
        report:
          outcome.report ??
          `Report.\n\n\`\`\`json\n${JSON.stringify({
            findings: (outcome.findings ?? []).map(
              ({ line, blocking, summary }) => ({
                file: 'plan.md',
                line,
                blocking,
                summary: summary ?? `issue on line ${line}`,
                correction: `fix line ${line}`,
              }),
            ),
          })}\n\`\`\``,
      };
    });
  };

  /** the edit each correction turn makes, by its index among them. */
  const corrections: ((prompt: string) => Promise<void>)[] = [];

  claude.onSend = async (prompt) => {
    if (!prompt.includes('Witch review')) return;

    const index = claude.inputs.filter(({ prompt }) =>
      prompt.includes('Witch review'),
    ).length;

    await corrections[index - 1]?.(prompt);
  };

  const correctionPrompts = () =>
    claude.inputs
      .filter(({ prompt }) => prompt.includes('Witch review'))
      .map(({ prompt }) => prompt);

  const notices = () =>
    coordinator.snapshot.items
      .filter(({ kind }) => kind === 'notice')
      .map(({ text }) => text ?? '');

  const notice = (start: string) =>
    notices().find((text) => text.startsWith(start));

  /** publishes a conflicting shared-memory note from another conversation. */
  const publishOutside = async (text: string) => {
    const id = 'outsider';

    await mkdir(join(f.root, 'state', 'conversations', id), {
      recursive: true,
    });

    const other = f.memory.workspace(
      join(f.root, 'state', 'conversations', id),
      id,
    );

    await other.ensureWorktree();
    await other.scope(cwd);
    const path = `${(await f.memory.scopePaths(cwd)).project}/notes.md`;
    await mkdir(join(other.root, path, '..'), { recursive: true });
    await writeFile(join(other.root, path), text);
    await other.commit('chore(memory): save outside notes');
    await other.publish();
  };

  return {
    f,
    coordinator,
    coordination,
    claude,
    cwd,
    lines,
    setLines,
    actions,
    state,
    rounds,
    corrections,
    correctionPrompts,
    notices,
    notice,
    publishOutside,
  };
}

/** runs commands as the UI's batches do, recording the ones that ran. */
function batches(h: Awaited<ReturnType<typeof harness>>) {
  const ran: string[] = [];
  const runner = new CommandBatches(h.coordinator);

  const submit = (commands: WitchCommand[]) =>
    runner.submit(commands, async ({ name, argument }) => {
      ran.push(name);

      return name === 'review' ? h.coordinator.review(argument) : true;
    });

  const idle = () => until('the batches', () => !runner.pending, 500);

  return { ran, submit, idle };
}

const names = (round: { reviewers: Reviewer[] }) =>
  round.reviewers.map(runtimeOf);

test('a single-harness change brings the quiet harness back', async (t) => {
  const h = await harness(t, undefined, coordinationFixture);

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? {
          findings: [
            { line: 5, blocking: true, summary: 'remember-port five' },
            { line: 25, blocking: false },
          ],
        }
      : round === 2
        ? { findings: [{ line: 15, blocking: true }] }
        : {};

  h.corrections.push(
    () => h.setLines({ 5: 'fixed five', 25: 'fixed twenty-five' }),
    () => h.setLines({ 15: 'fixed fifteen' }),
  );

  assert.equal(await h.coordinator.review('plan.md'), true);

  assert.deepEqual(h.rounds.map(names), [
    ['claude', 'codex'],
    ['claude'],
    ['claude', 'codex'],
    ['claude', 'codex'],
  ]);

  for (const action of h.actions)
    assert.deepEqual(action, {
      kind: 'route',
      work: 'review',
      of: { runtime: 'claude', model: 'claude-model' },
    });

  const [first, second, ...rest] = h.correctionPrompts();
  assert.deepEqual(rest, []);
  assert.match(first!, /Blocking[^\n]*\n- plan\.md:5: remember-port five/);
  assert.match(first!, /Non-blocking[^\n]*\n- plan\.md:25: issue on line 25/);
  assert.match(second!, /- plan\.md:15: issue on line 15/);
  assert.doesNotMatch(second!, /plan\.md:5:/);
  assert.match(h.notice('Review round 1')!, /claude · claude-opus-5-5/);
  assert.match(h.notice('Review round 1')!, /codex · gpt-6\.1-sol/);

  assert.match(
    h.notice('Review round 2')!,
    /claude · claude-opus-5-5; codex sits out: its reviewers found no blockers in round 1$/,
  );

  assert.doesNotMatch(h.notice('Review round 3')!, /sits out/);
  assert.match(h.rounds[1]!.brief, /^\+fixed five$/m);
  assert.match(h.rounds[2]!.brief, /^\+fixed fifteen$/m);
  assert.doesNotMatch(h.rounds[2]!.brief, /^\+fixed five$/m);
  assert.match(h.rounds[3]!.brief, /full text of every file/);

  assert.match(
    h.claude.inputs.find(({ prompt }) => prompt.includes('plan.md:15'))!
      .context!,
    /Use port 4567/,
  );

  assert.match(
    h.notice('Review finished')!,
    /^Review finished: settled: round 4 found no blockers in a full pass · 1 non-blocking findings sent · 0 mechanical failures remain/,
  );
});

test("each round's reviewers use the familiar prefix current when it starts", async (t) => {
  const h = await harness(t);
  const prefixes = h.coordination.commandPrefixes.bind(h.coordination);
  let familiar = '/before';
  h.coordination.commandPrefixes = () => ({ ...prefixes(), familiar });

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? { findings: [{ line: 5, blocking: true }] }
      : {};

  h.corrections.push(async () => {
    familiar = '/after';
    await h.setLines({ 5: 'fixed five' });
  });

  assert.equal(await h.coordinator.review('plan.md'), true);

  assert.deepEqual(
    h.rounds.map(({ reviewers }) =>
      reviewers.map(({ command }) => command.split(' ')[0]),
    ),
    [['/before', '/before'], ['/after'], ['/after', '/after']],
  );
});

test('blockers in the previous corrections stop the review', async (t) => {
  const h = await harness(t);

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude' ? { findings: [{ line: 5, blocking: true }] } : {};

  h.corrections.push(
    () => h.setLines({ 5: 'fixed five' }),
    () => h.setLines({ 5: 'fixed five again' }),
  );

  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.deepEqual(h.rounds.map(names), [['claude', 'codex'], ['claude']]);
  assert.equal(h.correctionPrompts().length, 2);

  assert.deepEqual(
    h.coordinator.snapshot.items
      .filter(({ kind }) => kind === 'user')
      .map(({ text }) => text),
    ['/review plan.md'],
  );

  assert.match(
    h.notice('Review finished')!,
    /^Review finished: every blocker sat on lines corrected since the last round/,
  );
});

test('a round leaves no abort listener on the review behind', async (t) => {
  const h = await harness(t);

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude' ? { findings: [{ line: 5, blocking: true }] } : {};

  h.corrections.push(
    () => h.setLines({ 5: 'fixed five' }),
    () => h.setLines({ 5: 'fixed five again' }),
  );

  const listeners: number[] = [];

  h.state.during = async () => {
    listeners.push(getEventListeners(h.rounds.at(-1)!.signal, 'abort').length);
  };

  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.equal(listeners.length, 2);
  assert.equal(listeners[1], listeners[0]);
});

test("a settling round's non-blocking findings get a final turn", async (t) => {
  const h = await harness(t);

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude' ? { findings: [{ line: 7, blocking: false }] } : {};

  h.corrections.push(() => h.setLines({ 7: 'tidied seven' }));
  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.equal(h.rounds.length, 1);
  assert.equal(h.correctionPrompts().length, 1);
  assert.match(h.notice('Review finished')!, /1 non-blocking findings sent/);
});

test("a correction turn that quotes a pasted image's marker sends no image", async (t) => {
  const h = await harness(t);
  const shot = join(h.cwd, 'shot.png');
  await writeFile(shot, png(1, 1));
  const marker = h.coordinator.paste(shot, '')!;

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude'
      ? { findings: [{ line: 7, blocking: false, summary: `see ${marker}` }] }
      : {};

  h.corrections.push(() => h.setLines({ 7: 'tidied seven' }));
  assert.equal(await h.coordinator.review('plan.md'), true);

  const [correction] = h.claude.inputs.filter(({ prompt }) =>
    prompt.includes('Witch review'),
  );

  assert.match(correction!.prompt, /see \[Image #1\]/);
  assert.equal(correction!.images, undefined);
});

test('a final correction that removes a target the checks skip fails the review', async (t) => {
  const h = await harness(t);

  const finding = {
    file: 'plan.ts',
    line: 1,
    blocking: false,
    summary: 'issue on line 1',
    correction: 'fix line 1',
  };

  await writeFile(join(h.cwd, 'plan.ts'), 'export {};\n');

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude'
      ? {
          report: `\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``,
        }
      : {};

  h.corrections.push(() => rm(join(h.cwd, 'plan.ts')));
  await assert.rejects(h.coordinator.review('plan.ts'), { code: 'ENOENT' });
  assert.equal(h.correctionPrompts().length, 1);
  assert.ok(!h.notice('Review finished'), h.notices().join('\n'));
});

test('sitting out never empties a round', async (t) => {
  const h = await harness(t);

  h.state.routes = (round) =>
    round === 1 ? [claudeRoute, codexRoute] : [codexRoute];

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? { findings: [{ line: 5, blocking: true }] }
      : {};

  h.corrections.push(() => h.setLines({ 5: 'fixed five' }));
  assert.equal(await h.coordinator.review('plan.md'), true);

  assert.deepEqual(h.rounds.map(names), [
    ['claude', 'codex'],
    ['codex'],
    ['codex'],
  ]);

  assert.doesNotMatch(h.notice('Review round 2')!, /sits out/);

  assert.match(
    h.notice('Review finished')!,
    /settled: round 3 found no blockers in a full pass/,
  );
});

test('a large correction gets a full pass', async (t) => {
  const h = await harness(t);

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? { findings: [{ line: 5, blocking: true }] }
      : {};

  h.corrections.push(() =>
    h.setLines(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [index + 1, `new ${index}`]),
      ),
    ),
  );

  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.match(h.rounds[1]!.brief, /full text of every file/);
});

test('an empty or bad target refuses', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.cwd, '..', 'outside.md'), 'x\n');

  for (const [argument, message] of [
    ['', 'Use /review <files>.'],
    ['missing.md', 'Review refused: missing.md is not a file'],
    ['../outside.md', 'Review refused: ../outside.md is not a file'],
  ] as const) {
    assert.equal(await h.coordinator.review(argument), false);
    assert.ok(h.notice(message), message);
  }

  assert.equal(h.rounds.length, 0);
  assert.equal(await h.coordinator.review('@plan.md'), true, 'file completion');
  assert.equal(h.rounds.length, 1);
  h.rounds.length = 0;
  assert.equal(h.correctionPrompts().length, 0);
  const runs = batches(h);

  runs.submit([
    { name: 'review', argument: '' },
    { name: 'clear', argument: '' },
  ]);

  await runs.idle();

  runs.submit([
    { name: 'review', argument: 'missing.md' },
    { name: 'clear', argument: '' },
  ]);

  await runs.idle();
  assert.deepEqual(runs.ran, ['review', 'review']);

  runs.submit([
    { name: 'review', argument: 'plan.md' },
    { name: 'clear', argument: '' },
  ]);

  await runs.idle();
  assert.deepEqual(runs.ran, ['review', 'review', 'review', 'clear']);
});

test('manual review refuses a checkout link to an outside file before routing', async (t) => {
  const h = await harness(t);
  const outside = join(h.cwd, '..', 'outside.md');
  await writeFile(outside, 'Outside the checkout.\n');
  await symlink(outside, join(h.cwd, 'link.md'));
  assert.equal(await h.coordinator.review('link.md'), false);

  assert.match(
    h.notice('Review refused: link.md') ?? '',
    /outside the allowed directories/,
  );

  assert.equal(h.rounds.length, 0);
});

test('quotes or a backslash keep a space inside a target name', async (t) => {
  const h = await harness(t);

  for (const name of ['a b.md', 'c d.md', 'e f.md'])
    await writeFile(join(h.cwd, name), 'x\n');

  assert.equal(await h.coordinator.review(`"a b.md" c\\ d.md @'e f.md'`), true);
  assert.match(h.rounds[0]!.brief, /^- a b\.md\n- c d\.md\n- e f\.md$/m);
});

test('a name quoted as file completion inserts it is reviewed', async (t) => {
  const h = await harness(t);

  for (const name of [
    'My Notes.md',
    "don't.md",
    'say "hi".md',
    'back\\slash.md',
    'trailing.md ',
  ])
    await writeFile(join(h.cwd, name), 'x\n');

  assert.equal(
    await h.coordinator.review(
      `@"My Notes.md" @"don't.md" @"say "\\""hi"\\"".md" @"back\\slash.md" @"trailing.md "`,
    ),
    true,
  );

  assert.ok(!h.notice('Review refused'), h.notices().join('\n'));

  assert.match(
    h.rounds[0]!.brief,
    /^- My Notes\.md\n- don't\.md\n- say "hi"\.md\n- back\\slash\.md\n- trailing\.md $/m,
  );
});

test('a target whose name holds a line break refuses, quoted or escaped', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.cwd, 'a\nb.md'), 'x\n');
  const targets = ['"a\nb.md"', 'a\\\nb.md', '@"a\nb.md"'];

  for (const argument of targets)
    assert.equal(await h.coordinator.review(argument), false, argument);

  assert.deepEqual(
    h.notices().filter((text) => text.startsWith('Review refused')),
    targets.map(
      () => 'Review refused: "a\\nb.md" has a line break in its name',
    ),
  );

  assert.equal(h.rounds.length, 0);
});

test('a target whose name starts with two dots is inside the directory', async (t) => {
  const h = await harness(t);
  await writeFile(join(h.cwd, '..notes.md'), 'x\n');
  assert.equal(await h.coordinator.review('..notes.md'), true);
  assert.ok(!h.notice('Review refused'), h.notices().join('\n'));
  assert.match(h.rounds[0]!.brief, /^- \.\.notes\.md$/m);
});

test('a target Witch cannot stat stops the review with the error', async (t) => {
  const h = await harness(t);
  const locked = join(h.cwd, 'locked');
  await mkdir(locked);
  await writeFile(join(locked, 'plan.md'), 'x\n');
  await chmod(locked, 0o000);

  try {
    await assert.rejects(h.coordinator.review('locked/plan.md'), {
      code: 'EACCES',
    });
  } finally {
    await chmod(locked, 0o700);
  }

  assert.match(h.coordinator.snapshot.error ?? '', /EACCES/);
  assert.ok(!h.notice('Review refused'), h.notices().join('\n'));
  assert.equal(h.rounds.length, 0);
});

test('a reviewer that fails, stops, exits non-zero, reports another model or writes an unparsable report stops the review', async (t) => {
  const h = await harness(t);

  const cases: [Outcome, RegExp][] = [
    [{ status: 'failed' }, /ended failed$/],
    [
      { status: 'failed', diagnostics: 'witch: EIO: report.md' },
      /ended failed: witch: EIO: report\.md$/,
    ],
    [{ status: 'stopped' }, /ended stopped$/],
    [{ code: 1 }, /exited with code 1$/],
    [
      { model: 'claude-haiku-5-5' },
      /ran on claude-haiku-5-5, not claude-opus-5-5$/,
    ],
    [
      { report: 'No findings block.' },
      /did not report findings: no closed json block$/,
    ],
    [
      { status: null, code: 1, diagnostics: 'witch: EEXIST: report.md' },
      /ended without registering: witch: EEXIST: report\.md$/,
    ],
    [{ status: null, code: 1 }, /ended without registering$/],
  ];

  for (const [outcome, reason] of cases) {
    h.state.outcome = (_round, { runtime }) =>
      runtime === 'claude' ? outcome : {};

    const before = h.notices().length;
    assert.equal(await h.coordinator.review('plan.md'), false);

    const stop = h
      .notices()
      .slice(before)
      .find((text) => text.startsWith('Review stopped'));

    const [text, report] = stop!.split(' · report ');
    assert.match(text!, /^Review stopped: review-[0-9a-f]{8}-1-claude /);
    assert.match(text!, reason);
    assert.match(report!, /\/review-[0-9a-f]{8}-1-claude\.md$/);
  }

  assert.equal(h.correctionPrompts().length, 0);
  assert.equal(h.notice('Review finished'), undefined);
});

test('every failed reviewer in a round is named in the stop notice', async (t) => {
  const h = await harness(t);

  h.state.outcome = (_round, { runtime }) => ({
    status: 'failed',
    diagnostics: `witch: ${runtime} broke`,
  });

  assert.equal(await h.coordinator.review('plan.md'), false);
  const stop = h.notice('Review stopped')!;
  assert.match(stop, /-claude ended failed: witch: claude broke · report /);
  assert.match(stop, /-codex ended failed: witch: codex broke · report /);
});

test('a refused route stops the review', async (t) => {
  const h = await harness(t);

  h.coordination.router = async () => ({
    kind: 'error',
    message: 'no runtime',
  });

  assert.equal(await h.coordinator.review('plan.md'), false);
  assert.equal(h.rounds.length, 0);
  assert.ok(h.notice('Review stopped: no runtime'));
  h.coordination.router = async () => ({ kind: 'route', routes: [] });
  assert.equal(await h.coordinator.review('plan.md'), false);
  assert.equal(h.rounds.length, 0);
  assert.ok(h.notice('Review stopped: no reviewer was routed'));
  assert.equal(h.notice('Review finished'), undefined);
});

test('targets changed while reviewers ran stop the review', async (t) => {
  const h = await harness(t);
  h.state.during = () => h.setLines({ 3: 'edited meanwhile' });
  assert.equal(await h.coordinator.review('plan.md'), false);

  assert.ok(
    h.notice('Review stopped: the targets changed while reviewers read them'),
  );

  assert.equal(h.correctionPrompts().length, 0);
});

test('unapplied blockers stop the review', async (t) => {
  const h = await harness(t);

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude' ? { findings: [{ line: 5, blocking: true }] } : {};

  assert.equal(await h.coordinator.review('plan.md'), false);
  assert.ok(h.notice('Review stopped: the blockers were not applied'));
});

test('failed mechanical checks get one correction turn before any reviewer', async (t) => {
  const h = await harness(t, {
    plan: `${['one', 'two — dash', ...target.slice(2)].join('\n')}\n`,
  });

  let reviewersBeforeFirst = -1;

  h.corrections.push(
    async () => {
      reviewersBeforeFirst = h.rounds.length;
    },
    async () => {
      const text = await h.lines();
      await writeFile(join(h.cwd, 'plan.md'), ['inserted', ...text].join('\n'));
    },
  );

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? { findings: [{ line: 10, blocking: true }] }
      : {};

  assert.equal(await h.coordinator.review('plan.md'), true);
  const [mechanical, ...others] = h.correctionPrompts();
  assert.equal(reviewersBeforeFirst, 0);
  assert.match(mechanical!, /mechanical check failures/);
  assert.match(mechanical!, /plan\.md:2: em dash in prose/);
  assert.ok(others.every((prompt) => !/mechanical check/.test(prompt)));
  assert.match(h.rounds[0]!.brief, /already reported[^]*plan\.md:2: em dash/);
  assert.match(h.notice('Review finished')!, /1 mechanical failures remain/);
});

test('a failure the mechanical correction introduces gets its own correction', async (t) => {
  const h = await harness(t, {
    plan: `${['one', 'two — dash', ...target.slice(2)].join('\n')}\n`,
  });

  h.corrections.push(
    () => h.setLines({ 2: 'two, see [x](missing.md)' }),
    () => h.setLines({ 2: 'two' }),
  );

  assert.equal(await h.coordinator.review('plan.md'), true);
  const [dash, link, ...others] = h.correctionPrompts();
  assert.match(dash!, /plan\.md:2: em dash in prose/);
  assert.match(link!, /plan\.md:2: link target missing\.md does not exist/);
  assert.deepEqual(others, []);
  assert.equal(h.rounds.length, 1);
  assert.match(h.notice('Review finished')!, /0 mechanical failures remain/);
});

test('Escape while reviewers run aborts them with the native stop deadline', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  h.state.hold = held.promise;
  const reviewing = h.coordinator.review('plan.md');
  await until('the reviewers', () => h.rounds.length === 1, 500);
  const deadline = performance.now() + 2000;
  const interrupting = h.coordinator.interrupt({ deadline });
  const { signal } = h.rounds[0]!;
  await until('the abort', () => signal.aborted, 500);
  assert.ok(signal.reason instanceof NativeStop);
  assert.equal(signal.reason.options.deadline, deadline);
  held.resolve();
  await interrupting;
  assert.equal(await reviewing, false);
  assert.equal(h.correctionPrompts().length, 0);
  assert.equal(h.notice('Review finished'), undefined);
});

test('a review refused while another runs leaves Escape able to stop the first', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  h.state.hold = held.promise;
  const reviewing = h.coordinator.review('plan.md');
  await until('the reviewers', () => h.rounds.length === 1, 500);
  await assert.rejects(h.coordinator.review('plan.md'), /Stop the current/);
  const interrupting = h.coordinator.interrupt();
  await until('the abort', () => h.rounds[0]!.signal.aborted, 500);
  held.resolve();
  await interrupting;
  assert.equal(await reviewing, false);
});

test('Escape while a review settles fails it without a finished notice', async (t) => {
  const h = await harness(t);
  const settling = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const flush = ConversationStore.prototype.flush;

  h.state.during = async () => {
    vi.spyOn(ConversationStore.prototype, 'flush').mockImplementation(
      async function (this: ConversationStore) {
        settling.resolve();
        await held.promise;

        return flush.call(this);
      },
    );
  };

  const reviewing = h.coordinator.review('plan.md');
  await within(settling.promise, 3000, 'settlement');
  const interrupting = h.coordinator.interrupt();
  held.resolve();
  await interrupting;
  assert.equal(await reviewing, false);
  assert.equal(h.notice('Review finished'), undefined);
});

test('closing Witch during a review aborts its reviewers', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  h.state.hold = held.promise;
  const reviewing = h.coordinator.review('plan.md');
  await until('the reviewers', () => h.rounds.length === 1, 500);
  const closing = h.coordinator.close();
  await until('the abort', () => h.rounds[0]!.signal.aborted, 500);
  assert.ok(h.rounds[0]!.signal.reason instanceof NativeStop);
  held.resolve();
  await closing;
  assert.equal(await reviewing, false);
});

test('closing Witch as a round starts ends the review cleanly', async (t) => {
  const h = await harness(t);
  let closing: Promise<void> | undefined;

  const stop = h.coordinator.subscribe(() => {
    if (!closing && h.notice('Review round 1')) closing = h.coordinator.close();
  });

  const reviewing = h.coordinator.review('plan.md');
  await until('the close', () => closing !== undefined, 500);
  stop();
  await closing;
  assert.equal(await reviewing, false);
  assert.equal(h.notice('Review finished'), undefined);
});

test('closing Witch fails when a reviewer outlives the stop deadline', async (t) => {
  const h = await harness(t);
  let started = false;

  h.coordinator.reviewers.run = ({ signal }) => {
    started = true;

    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new NativeStopTimeout()), {
        once: true,
      }),
    );
  };

  const reviewing = h.coordinator.review('plan.md').then(
    () => undefined,
    (error: unknown) => error,
  );

  await until('the reviewers', () => started, 500);
  await assert.rejects(h.coordinator.close(), NativeStopTimeout);
  assert.ok((await reviewing) instanceof NativeStopTimeout);
});

test('Escape during routing launches no reviewer', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  let routing: Promise<ControlOutcome> | undefined;

  h.coordination.router = () =>
    (routing = held.promise.then(() => ({
      kind: 'route',
      routes: [claudeRoute],
    })));

  const reviewing = h.coordinator.review('plan.md');
  await until('the route request', () => routing !== undefined, 500);
  await h.coordinator.interrupt();
  assert.equal(await within(reviewing, 3000, 'the review'), false);
  held.resolve();
  await routing;
  assert.equal(h.rounds.length, 0);
});

/** a policy that routes review to Claude, so only cancellation can stop a held route. */
const routable = {
  shiftAt: null,
  families: {},
  work: { review: 'claude:claude-opus-5-5' },
};

/** interrupts a review whose route is held, opens another conversation, then releases the route, which must answer cancelled and post nothing. */
async function cancelHeldRoute(
  h: Awaited<ReturnType<typeof harness>>,
  read: () => Promise<typeof routable>,
  held: { waiting: () => boolean; release: () => void },
  readDemand: (deadline: number) => Promise<Demand> = (deadline) =>
    h.coordination.routingDemand(deadline),
) {
  const route = router(h.coordinator, { read }, readDemand);
  let routed: ReturnType<typeof route> | undefined;
  h.coordination.router = (action, signal) => (routed = route(action, signal));
  const reviewing = h.coordinator.review('plan.md');
  await until('the held route', held.waiting, 500);
  await h.coordinator.interrupt();
  assert.equal(await within(reviewing, 3000, 'the review'), false);
  await h.coordinator.newConversation();
  held.release();

  assert.deepEqual(await within(routed!, 5000, 'the cancelled route'), {
    kind: 'error',
    message: 'Route cancelled.',
  });

  assert.ok(
    !h.notices().some((text) => /^Route|^Routed/.test(text)),
    h.notices().join('\n'),
  );
}

test('a route cancelled during its policy read posts nothing later', async (t) => {
  const h = await harness(t);

  for (const outcome of ['read', 'failed']) {
    const gate = Promise.withResolvers<void>();
    let reading = false;

    await cancelHeldRoute(
      h,
      async () => {
        reading = true;
        await gate.promise;

        if (outcome === 'failed') throw new Error('policy unreadable');

        return routable;
      },
      { waiting: () => reading, release: () => gate.resolve() },
    );
  }
});

test('a route cancelled during its workload read posts no late choice or failure', async (t) => {
  const h = await harness(t);

  for (const outcome of ['read', 'failed']) {
    const gate = Promise.withResolvers<void>();
    let reading = false;

    await cancelHeldRoute(
      h,
      async () => routable,
      { waiting: () => reading, release: () => gate.resolve() },
      async () => {
        reading = true;
        await gate.promise;

        if (outcome === 'failed') throw new Error('workload unreadable');

        return { coordinators: {}, unknown: ['claude', 'codex'] };
      },
    );

    assert.ok(
      !h.notices().some((text) => text.includes('workload unreadable')),
    );
  }
});

test('a route cancelled during its usage refresh posts nothing later', async (t) => {
  const h = await harness(t);
  const gate = Promise.withResolvers<void>();
  let refreshing = false;

  h.coordinator.accountUsage.refresh = async () => {
    refreshing = true;
    await gate.promise;
  };

  await cancelHeldRoute(h, async () => routable, {
    waiting: () => refreshing,
    release: () => gate.resolve(),
  });
});

test('an interrupted correction turn ends the review and keeps its memory pending', async (t) => {
  const h = await harness(t, undefined, coordinationFixture);

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude'
      ? { findings: [{ line: 5, blocking: true, summary: 'remember:pending' }] }
      : {};

  h.claude.interruptNext = false;

  h.corrections.push(async () => {
    h.claude.interruptNext = true;
  });

  assert.equal(await h.coordinator.review('plan.md'), false);
  assert.equal(h.rounds.length, 1);
  assert.equal(h.coordinator.snapshot.recovery?.kind, 'pending');
});

test('a publication conflict after a correction stops the review', async (t) => {
  const h = await harness(t, undefined, coordinationFixture);

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? {
          findings: [{ line: 5, blocking: true, summary: 'remember:mine' }],
        }
      : {};

  h.corrections.push(() => h.setLines({ 5: 'fixed five' }));
  const gate = new TurnGate();
  h.claude.gate = gate;
  const reviewing = h.coordinator.review('plan.md');
  await within(gate.entered, 3000, 'the correction turn');
  await h.publishOutside('theirs');
  gate.open();
  assert.equal(await reviewing, false);
  assert.equal(h.rounds.length, 1);
  assert.equal(h.coordinator.snapshot.recovery?.kind, 'conflict');
  assert.equal(h.notice('Review finished'), undefined);

  assert.equal(
    await h.f.memory.read(
      main,
      `${(await h.f.memory.scopePaths(h.cwd)).project}/notes.md`,
    ),
    'theirs',
  );
});

test("a final turn's memory publication failure fails the review", async (t) => {
  const h = await harness(t, undefined, coordinationFixture);

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude'
      ? { findings: [{ line: 7, blocking: false, summary: 'remember:seven' }] }
      : {};

  h.corrections.push(async () => {
    vi.spyOn(Workspace.prototype, 'publish').mockRejectedValueOnce(
      new Error('remote refused'),
    );
  });

  assert.equal(await h.coordinator.review('plan.md'), false);
  assert.equal(h.correctionPrompts().length, 1);
  assert.ok(h.notice('Memory publication failed: remote refused'));
  assert.equal(h.notice('Review finished'), undefined);
});

test('prompts typed during a review wait for it', async (t) => {
  const h = await harness(t);

  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? { findings: [{ line: 5, blocking: true }] }
      : {};

  h.corrections.push(() => h.setLines({ 5: 'fixed five' }));
  const gate = new TurnGate();
  h.claude.gate = gate;
  const runs = batches(h);
  runs.submit([{ name: 'review', argument: 'plan.md' }]);
  await within(gate.entered, 3000, 'the correction turn');
  await h.coordinator.send('typed meanwhile');
  assert.deepEqual(h.claude.steers, []);
  assert.deepEqual(h.coordinator.snapshot.queue, ['typed meanwhile']);
  gate.open();
  await runs.idle();

  await until(
    'the typed prompt',
    () => h.claude.inputs.some(({ prompt }) => prompt === 'typed meanwhile'),
    500,
  );

  const prompts = h.claude.inputs.map(({ prompt }) => prompt);

  assert.ok(
    prompts.indexOf('typed meanwhile') >
      prompts.findLastIndex((prompt) => prompt.includes('Witch review')),
  );
});

test('a correction turn compacts first when context is high', async (t) => {
  const h = await harness(t, { usage: { context: 95 } });

  h.state.outcome = (_round, { runtime }) =>
    runtime === 'claude' ? { findings: [{ line: 5, blocking: false }] } : {};

  let compactedBefore: number | undefined;

  h.corrections.push(() => {
    compactedBefore = h.claude.compactions.length;

    return h.setLines({ 5: 'tidied' });
  });

  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.equal(compactedBefore, 1);
  assert.equal(h.claude.compactions.length, 1);
});

test("a first review keeps handoff's summary", async (t) => {
  const h = await harness(t);
  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.equal(h.claude.inputs.length, 0);
  await h.coordinator.selectModel({ agent: 'codex', id: 'codex-model' });

  const summary = h.claude.inputs.find(({ prompt }) =>
    prompt.startsWith('Produce a concise handoff summary'),
  );

  assert.ok(summary, 'the handoff summary turn ran');
  assert.match(summary.context!, /Witch ran \/review plan\.md: settled/);
});
