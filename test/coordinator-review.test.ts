import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { NativeStop } from '../src/agents/shutdown.js';
import type { Usage } from '../src/agents/types.js';
import { router } from '../src/core/router.js';
import type { Reviewer, ReviewerResult } from '../src/core/reviewers.js';
import type { Routed } from '../src/core/routing.js';
import { main } from '../src/memory/memory.js';
import { CommandBatches } from '../src/ui/command-batches.js';
import type { WitchCommand } from '../src/ui/commands.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { coordinationFixture } from './fixtures/coordination.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

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
  status?: ReviewerResult['status'];
  code?: number | null;
  model?: string;
  report?: string;
}

const target = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

async function harness(
  t: TestContext,
  options: { usage?: Usage; plan?: string } = {},
) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = await scratch('witch-review-tmp-');
  t.onTestFinished(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  const f = await coordinationFixture(orderedCleanup(t.onTestFinished));
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
    outcome: (round: number, reviewer: Reviewer) => Outcome;
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
      const outcome = state.outcome(rounds.length, reviewer);
      const model = /'--model' '([^']+)'|'model="([^"]+)"'/.exec(
        reviewer.command,
      )!;
      return {
        name: reviewer.name,
        code: outcome.code === undefined ? 0 : outcome.code,
        status: outcome.status ?? 'completed',
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
    codex,
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
  round.reviewers.map(({ runtime }) => runtime);

test('a single-harness change brings the quiet harness back', async (t) => {
  const h = await harness(t);
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
    /^Review finished: settled: round 4 found no blockers in a full pass · 0 non-blocking findings sent · 0 mechanical failures remain/,
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
  assert.match(
    h.notice('Review finished')!,
    /^Review finished: every blocker sat in the previous round's corrections/,
  );
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

test('sitting out never empties a round', async (t) => {
  const h = await harness(t);
  h.state.routes = (round) =>
    round === 1 ? [claudeRoute, codexRoute] : [codexRoute, codexRoute];
  h.state.outcome = (round, { runtime }) =>
    round === 1 && runtime === 'claude'
      ? { findings: [{ line: 5, blocking: true }] }
      : {};
  h.corrections.push(() => h.setLines({ 5: 'fixed five' }));
  assert.equal(await h.coordinator.review('plan.md'), true);
  assert.deepEqual(h.rounds.map(names), [
    ['claude', 'codex'],
    ['codex', 'codex'],
    ['codex', 'codex'],
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

test('a reviewer that fails, stops, exits non-zero, reports another model or writes an unparsable report stops the review', async (t) => {
  const h = await harness(t);
  const cases: [Outcome, RegExp][] = [
    [{ status: 'failed' }, /ended failed$/],
    [{ status: 'stopped' }, /ended stopped$/],
    [{ code: 1 }, /exited with code 1$/],
    [
      { model: 'claude-haiku-5-5' },
      /ran on claude-haiku-5-5, not claude-opus-5-5$/,
    ],
    [{ report: 'No findings block.' }, /did not report findings$/],
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
    assert.match(stop!, /^Review stopped: review-[0-9a-f]{8}-1-claude-0 /);
    assert.match(stop!, reason);
  }
  assert.equal(h.correctionPrompts().length, 0);
  assert.equal(h.notice('Review finished'), undefined);
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

test('Escape while reviewers run aborts them with the native stop deadline', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  h.state.hold = held.promise;
  const reviewing = h.coordinator.review('plan.md');
  await until('the reviewers', () => h.rounds.length === 1, 500);
  const deadline = performance.now() + 2000;
  await h.coordinator.interrupt({ deadline });
  const { signal } = h.rounds[0]!;
  assert.ok(signal.aborted);
  assert.ok(signal.reason instanceof NativeStop);
  assert.equal(signal.reason.options.deadline, deadline);
  held.resolve();
  assert.equal(await reviewing, false);
  assert.equal(h.correctionPrompts().length, 0);
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

test('Escape during routing launches no reviewer', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  let routing = false;
  h.coordination.router = async () => {
    routing = true;
    await held.promise;
    return { kind: 'route', routes: [claudeRoute] };
  };
  const reviewing = h.coordinator.review('plan.md');
  await until('the route request', () => routing, 500);
  await h.coordinator.interrupt();
  assert.equal(await within(reviewing, 3000, 'the review'), false);
  held.resolve();
  await new Promise((settle) => setTimeout(settle, 50));
  assert.equal(h.rounds.length, 0);
});

test('a cancelled route posts nothing later', async (t) => {
  const h = await harness(t);
  const held = Promise.withResolvers<void>();
  let reading = false;
  h.coordination.router = router(h.coordinator, {
    read: async () => {
      reading = true;
      await held.promise;
      return { shiftAt: null, families: {}, work: {} };
    },
  });
  const reviewing = h.coordinator.review('plan.md');
  await until('the policy read', () => reading, 500);
  await h.coordinator.interrupt();
  assert.equal(await within(reviewing, 3000, 'the review'), false);
  await h.coordinator.newConversation();
  held.resolve();
  await new Promise((settle) => setTimeout(settle, 3500));
  assert.ok(
    !h.notices().some((text) => /^Route|^Routed/.test(text)),
    h.notices().join('\n'),
  );
});

test('an interrupted correction turn ends the review and keeps its memory pending', async (t) => {
  const h = await harness(t);
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
  const h = await harness(t);
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
  h.corrections.push(() => h.setLines({ 5: 'tidied' }));
  assert.equal(await h.coordinator.review('plan.md'), true);
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
