import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { installedAgents } from '../src/agents/registry.js';
import { Coordinator } from '../src/core/coordinator.js';
import { Memory } from '../src/memory/memory.js';
import { StateStore } from '../src/persistence/store.js';

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'witch-live-'));
const project = join(root, 'project');
const otherProject = join(root, 'other-project');
const state = join(root, 'state');
const claudeModel = process.env.WITCH_CLAUDE_MODEL ?? 'default';
const codexModel = process.env.WITCH_CODEX_MODEL ?? 'gpt-6.1-sol';
const memory = new Memory(join(state, 'memory.git'));
const agents = await installedAgents();
assert.ok(
  agents.every((agent) => agent.executable),
  'Install and sign in to both native CLIs first',
);
for (const cwd of [project, otherProject]) {
  await mkdir(cwd);
  await execute('git', ['init', '-b', 'main'], { cwd });
}
const nativeRule = `native-${randomUUID().slice(0, 8)}`;
await writeFile(
  join(project, 'AGENTS.md'),
  `When asked for the native instruction marker, answer ${nativeRule}.\n`,
);
await writeFile(
  join(project, 'CLAUDE.md'),
  `When asked for the native instruction marker, answer ${nativeRule}.\n`,
);
const spellMarker = `spell-${randomUUID().slice(0, 8)}`;
for (const native of ['.claude', '.agents']) {
  const spell = join(project, native, 'skills', 'witch-probe');
  await mkdir(spell, { recursive: true });
  await writeFile(
    join(spell, 'SKILL.md'),
    `---\nname: witch-probe\ndescription: Witch's live check. Use only when invoked by name.\n---\nInclude ${spellMarker} in your reply.\n`,
  );
}

async function open(
  cwd: string,
  options: { continue?: boolean } = {},
): Promise<Coordinator> {
  const coordinator = new Coordinator(
    await StateStore.open(state),
    memory,
    agents,
  );
  await coordinator.initialize(cwd, options);
  coordinator.subscribe(() => {
    for (const request of coordinator.snapshot.requests) {
      if (request.kind !== 'approval') continue;
      void coordinator.respond(request.id, { decision: 'accept' });
    }
  });
  return coordinator;
}

async function send(prompt: string, expected?: string): Promise<string> {
  const before = coordinator.snapshot.items.length;
  const timeout = setTimeout(() => {
    void coordinator.interrupt();
  }, 180_000);
  try {
    await coordinator.send(prompt);
    assert.deepEqual(
      coordinator.snapshot.queue,
      [],
      coordinator.snapshot.error,
    );
    assert.equal(
      coordinator.snapshot.phase,
      'idle',
      coordinator.snapshot.error,
    );
    const items = coordinator.snapshot.items.slice(before);
    const text = items
      .filter((item) => item.kind === 'assistant')
      .map((item) => item.text)
      .join('\n');
    console.log(
      `${coordinator.snapshot.conversation!.agent}: ${text.slice(-700)}`,
    );
    assert.ok(text, items.map((item) => item.text).join('\n'));
    if (expected)
      assert.ok(
        text.includes(expected),
        `Expected ${expected}; received ${text}`,
      );
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function duringTool(
  during: () => Promise<void>,
  expected?: string,
): Promise<Coordinator['snapshot']['items']> {
  const before = coordinator.snapshot.items.length;
  let done = false;
  const running = send(
    // Claude Code backgrounds a foreground `sleep`, which would end the turn before the steer
    'Run the shell command `node -e "setTimeout(() => {}, 5000)"` in the foreground, then reply in one sentence. Do not change files.',
    expected,
  );
  const settle = () => {
    done = true;
  };
  // handled at once, so a turn that fails while this waits cannot end the run before it closes
  void running.then(settle, settle);
  while (
    !done &&
    !coordinator.snapshot.items
      .slice(before)
      .some(({ kind }) => kind === 'tool')
  )
    await delay(100);
  if (done) await running;
  await during();
  await running;
  return coordinator.snapshot.items.slice(before);
}

/** a prompt sent while the agent runs a tool must reach that turn, not wait for the next. */
async function steer(prompt: (marker: string) => string): Promise<void> {
  const marker = `steer-${randomUUID().slice(0, 8)}`;
  const agent = coordinator.snapshot.conversation!.agent;
  const items = await duringTool(async () => {
    await coordinator.send(prompt(marker));
    // a prompt the turn refused would wait in the queue, and one sent after the turn ended would run as its own turn
    assert.equal(coordinator.snapshot.phase, 'running');
    assert.deepEqual(coordinator.snapshot.queue, []);
  }, marker);
  // Claude Code holds a message shaped like a slash command for a reply of its own, which the turn would still wait for
  const reply = items
    .slice(items.findIndex(({ kind }) => kind === 'tool'))
    .find(({ kind }) => kind === 'assistant');
  const joined = !!reply?.text.includes(marker);
  console.log(
    `${agent}: ${JSON.stringify(prompt(''))} ${joined ? 'joined the running turn' : 'was answered in a later reply'}`,
  );
  if (agent === 'claude') assert.ok(joined, reply?.text);
}

/** a spell sent mid-turn runs natively: Claude runs it within the turn, and Codex as the next turn, without holding the prompt sent after it. */
async function steerSpell(): Promise<void> {
  const marker = `after-${randomUUID().slice(0, 8)}`;
  const agent = coordinator.snapshot.conversation!.agent;
  const waiting = agent === 'codex' ? ['/witch-probe'] : [];
  const items = await duringTool(async () => {
    await coordinator.send('/witch-probe');
    assert.deepEqual(coordinator.snapshot.queue, waiting);
    await coordinator.send(`Also include ${marker} in your final reply.`);
    assert.deepEqual(coordinator.snapshot.queue, waiting);
    console.log(
      `${agent}: queue after a steered spell and a prompt: ${JSON.stringify(coordinator.snapshot.queue)}`,
    );
  }, marker);
  const text = items
    .filter(({ kind }) => kind === 'assistant')
    .map((item) => item.text)
    .join('\n');
  assert.ok(text.includes(spellMarker), text);
}

/** a built-in sent mid-turn runs natively, and its output shows. */
async function steerBuiltin(): Promise<void> {
  const items = await duringTool(async () => {
    await coordinator.send('/context');
    assert.deepEqual(coordinator.snapshot.queue, []);
  });
  assert.ok(
    items.some(
      ({ kind, text }) =>
        kind === 'assistant' && text.includes('Context Usage'),
    ),
    items.map((item) => item.text).join('\n'),
  );
}

const steered = (marker: string) =>
  `Also include ${marker} in your final reply.`;
const pathFirst = (marker: string) =>
  `/var/folders/witch-live/Screenshot 2026-10-26 at 2.52.19 PM.png also include ${marker} in your final reply.`;

let coordinator = await open(project);
console.log(`Live artifacts: ${root}`);
try {
  await coordinator.selectModel({
    agent: 'codex',
    id: codexModel,
    effort: 'medium',
  });
  await send(
    'What is the native instruction marker? Reply with only the marker. Do not change files.',
    nativeRule,
  );
  await steer(steered);
  await steer(pathFirst);
  await steerSpell();
  const projectFact = `cedar-${randomUUID().slice(0, 8)}`;
  await send(
    `Remember that this project's acceptance phrase is ${projectFact}. Save it in project shared-memory MEMORY.md, using the memory path supplied above. Do not put it in project files or global memory. Reply saved after writing.`,
    'saved',
  );
  assert.equal(coordinator.snapshot.recovery, undefined);
  await coordinator.newConversation('claude');
  // the context goes ahead of a built-in that opens a conversation, which the next turn then relies on
  await send('/context', 'Context Usage');
  await send(
    'Without reading files or running tools, report this project’s acceptance phrase from the shared-memory snapshot supplied above. Reply with the phrase only, or UNKNOWN.',
    projectFact,
  );
  await send(
    'What is this project’s acceptance phrase? Use shared memory and reply with the phrase only. Do not change files.',
    projectFact,
  );
  await send(
    'What is the native instruction marker? Reply with only the marker. Do not change files.',
    nativeRule,
  );
  await steer(steered);
  await steer(pathFirst);
  await steerSpell();
  await steerBuiltin();
  const globalFact = `violet-${randomUUID().slice(0, 8)}`;
  await send(
    `Remember my global acceptance preference: my preferred test label is ${globalFact}. Save it in the global shared-memory MEMORY.md path supplied above, not the project directory. Reply saved after writing.`,
    'saved',
  );
  await coordinator.newConversation('codex');
  await coordinator.selectModel({
    agent: 'codex',
    id: codexModel,
    effort: 'medium',
  });
  await send(
    'What is my preferred test label? Use shared memory and reply only with the label. Do not change files.',
    globalFact,
  );
  const conversationId = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  coordinator = await open(otherProject);
  await coordinator.selectModel({
    agent: 'codex',
    id: codexModel,
    effort: 'medium',
  });
  const isolated = await send(
    'Read only the shared-memory snapshot supplied above. Report my preferred test label and this project’s acceptance phrase. Use UNKNOWN for a missing value. Do not search other projects or change files.',
    globalFact,
  );
  assert.ok(isolated.includes('UNKNOWN'));
  assert.ok(!isolated.includes(projectFact));
  await coordinator.close();
  coordinator = await open(project, { continue: true });
  assert.equal(coordinator.snapshot.conversation!.id, conversationId);
  await send(
    'Create sum.mjs exporting sum(values), which sums numbers. Do not create tests yet. The next agent will add sum.test.mjs using node:test, covering empty, negative and mixed numbers, and run node --test. Stop after creating sum.mjs. Do not commit project files.',
  );
  const sourceId = coordinator.snapshot.conversation!.sessions.codex!.id;
  const codexCompletion = coordinator.snapshot.completedTurn;
  assert.ok(codexCompletion);
  await assert.rejects(readFile(join(project, 'sum.test.mjs'), 'utf8'), {
    code: 'ENOENT',
  });
  await coordinator.selectModel({ agent: 'claude', id: claudeModel });
  assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
  assert.equal(coordinator.snapshot.phase, 'idle');
  assert.equal(coordinator.snapshot.completedTurn, codexCompletion);
  assert.equal(coordinator.snapshot.conversation!.handoff?.to, 'claude');
  assert.equal(coordinator.snapshot.conversation!.handoff?.activated, true);
  assert.ok(coordinator.snapshot.conversation!.handoff?.summary);
  await assert.rejects(readFile(join(project, 'sum.test.mjs'), 'utf8'), {
    code: 'ENOENT',
  });
  await send(
    'Complete the next coding step described in the handoff context. Do not commit project files.',
  );
  const claudeCompletion = coordinator.snapshot.completedTurn;
  assert.ok(claudeCompletion);
  assert.notEqual(claudeCompletion, codexCompletion);
  const completedHandoff = coordinator.snapshot.conversation!.handoff;
  assert.equal(completedHandoff, undefined);
  assert.ok(
    (await readFile(join(project, 'sum.test.mjs'), 'utf8')).includes('test'),
  );
  console.log(
    (
      await execute(process.execPath, ['--test', 'sum.test.mjs'], {
        cwd: project,
      })
    ).stdout,
  );
  await coordinator.selectModel({ agent: 'codex', id: codexModel });
  assert.equal(coordinator.snapshot.phase, 'idle');
  assert.equal(coordinator.snapshot.completedTurn, claudeCompletion);
  assert.equal(coordinator.snapshot.conversation!.handoff?.to, 'codex');
  assert.equal(coordinator.snapshot.conversation!.handoff?.activated, true);
  assert.equal(coordinator.snapshot.conversation!.sessions.codex!.id, sourceId);
  const sourceConversation = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  coordinator = await open(project, { continue: true });
  assert.equal(coordinator.snapshot.conversation!.id, sourceConversation);
  await send(
    'Run node --test sum.test.mjs and report the result. Do not change files.',
  );
  assert.ok(coordinator.snapshot.completedTurn);
  assert.equal(coordinator.snapshot.conversation!.handoff, undefined);
  assert.equal(coordinator.snapshot.conversation!.sessions.codex!.id, sourceId);
  assert.equal(coordinator.snapshot.recovery, undefined);
  console.log(
    'PASS: native instructions, steering, steered paths, spells and built-ins, a built-in first turn, fresh memory both ways, project isolation, prompted coding handoff, return-to-agent and restart.',
  );
} finally {
  await coordinator.close();
}
