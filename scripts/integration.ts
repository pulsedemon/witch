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

/** a prompt sent while the agent runs a tool must reach that turn, not wait for the next. */
async function steer(): Promise<void> {
  const marker = `steer-${randomUUID().slice(0, 8)}`;
  const before = coordinator.snapshot.items.length;
  let done = false;
  const running = send(
    'Run the shell command `sleep 5`, then reply in one sentence. Do not change files.',
    marker,
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
  // a turn that ended first throws its own failure
  if (done) await running;
  await coordinator.send(`Also include ${marker} in your final reply.`);
  // a prompt the turn refused would wait in the queue, and one sent after the turn ended would run as its own turn
  assert.equal(coordinator.snapshot.phase, 'running');
  assert.deepEqual(coordinator.snapshot.queue, []);
  await running;
}

let coordinator = await open(project);
console.log(`Live artifacts: ${root}`);
try {
  await coordinator.selectModel(codexModel, 'medium');
  await send(
    'What is the native instruction marker? Reply with only the marker. Do not change files.',
    nativeRule,
  );
  await steer();
  const projectFact = `cedar-${randomUUID().slice(0, 8)}`;
  await send(
    `Remember that this project's acceptance phrase is ${projectFact}. Save it in project shared-memory MEMORY.md, using the memory path supplied above. Do not put it in project files or global memory. Reply saved after writing.`,
    'saved',
  );
  assert.equal(coordinator.snapshot.recovery, undefined);
  await coordinator.newConversation('claude');
  await send(
    'What is this project’s acceptance phrase? Use shared memory and reply with the phrase only. Do not change files.',
    projectFact,
  );
  await send(
    'What is the native instruction marker? Reply with only the marker. Do not change files.',
    nativeRule,
  );
  await steer();
  const globalFact = `violet-${randomUUID().slice(0, 8)}`;
  await send(
    `Remember my global acceptance preference: my preferred test label is ${globalFact}. Save it in the global shared-memory MEMORY.md path supplied above, not the project directory. Reply saved after writing.`,
    'saved',
  );
  await coordinator.newConversation('codex');
  await coordinator.selectModel(codexModel, 'medium');
  await send(
    'What is my preferred test label? Use shared memory and reply only with the label. Do not change files.',
    globalFact,
  );
  const conversationId = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  coordinator = await open(otherProject);
  await coordinator.selectModel(codexModel, 'medium');
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
  await coordinator.switchAgent('claude');
  assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
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
  await coordinator.switchAgent('codex');
  assert.equal(coordinator.snapshot.conversation!.sessions.codex!.id, sourceId);
  const sourceConversation = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  coordinator = await open(project, { continue: true });
  assert.equal(coordinator.snapshot.conversation!.id, sourceConversation);
  await send(
    'Run node --test sum.test.mjs and report the result. Do not change files.',
  );
  assert.equal(coordinator.snapshot.conversation!.sessions.codex!.id, sourceId);
  assert.equal(coordinator.snapshot.recovery, undefined);
  console.log(
    'PASS: native instructions, steering, fresh memory both ways, project isolation, coding handoff, return-to-agent and restart.',
  );
} finally {
  await coordinator.close();
}
