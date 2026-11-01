import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentSession } from '../../src/agents/types.js';
import { Coordinator } from '../../src/core/coordinator.js';
import type { Conversation, ConversationRecord } from '../../src/core/state.js';
import { ConversationStore, StateStore } from '../../src/persistence/store.js';
import { FixtureAgent } from './agent.js';
import { hookedGit, passThrough } from './git.js';
import { scratch } from './scratch.js';
import { seededMemory } from './seeded-memory.js';

export function record(id: string, cwd: string, agent = 'a'): Conversation {
  return {
    id,
    title: `Title ${id}`,
    cwd,
    agent,
    sessions: {},
    createdAt: new Date().toISOString(),
  };
}

export function activity(): ConversationRecord['activity'] {
  return {
    id: 'stale-turn',
    agent: 'a',
    kind: 'turn',
    baseRevision: 'unknown',
    startedAt: new Date().toISOString(),
  };
}

/** holds the save after the session's first turn returns, where only Witch's settlement keeps the turn running. */
export function holdSettlement(session: AgentSession) {
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const save = ConversationStore.prototype.save;
  let armed: boolean | undefined;
  const send = session.send.bind(session);
  session.send = async (...args) => {
    const result = await send(...args);
    armed ??= true;
    return result;
  };
  ConversationStore.prototype.save = function (record) {
    if (!armed) return save.call(this, record);
    armed = false;
    entered.resolve();
    return held.promise.then(() => save.call(this, record));
  };
  return {
    entered: entered.promise,
    release: () => held.resolve(),
    fail: (error: Error) => held.reject(error),
    /** releases a pending hold, so close() can't wait on it. */
    restore: () => {
      held.resolve();
      ConversationStore.prototype.save = save;
    },
  };
}

export async function readRecord(
  root: string,
  id: string,
): Promise<ConversationRecord> {
  return JSON.parse(
    await readFile(
      join(root, 'state', 'conversations', id, 'state.json'),
      'utf8',
    ),
  ) as ConversationRecord;
}

export async function fixture(
  editFile?: ConstructorParameters<typeof Coordinator>[4],
  /** runs before the launch connects. */
  prepare?: (a: FixtureAgent, b: FixtureAgent) => void,
) {
  const root = await scratch('witch-coordinator-');
  const project = join(root, 'project');
  await mkdir(project);
  const store = await StateStore.open(join(root, 'state'));
  const hook = { current: passThrough };
  const memory = await seededMemory(
    join(root, 'state', 'memory.git'),
    hookedGit(hook),
  );
  const a = new FixtureAgent('a');
  const b = new FixtureAgent('b');
  const agents = [a, b].map((adapter) => ({ adapter, executable: adapter.id }));
  const tracked: number[] = [];
  /** the activity the coordinator reports to the job watch, once per change. */
  const active: boolean[] = [];
  const jobs = {
    track: (group: number) => tracked.push(group),
    setActive: (value: boolean) => {
      if (active.at(-1) !== value) active.push(value);
    },
    environment: {},
  };
  const coordinator = new Coordinator(store, memory, agents, jobs, editFile);
  prepare?.(a, b);
  await coordinator.initialize(project);
  const workspace = (id = coordinator.snapshot.conversation!.id) =>
    memory.workspace(join(root, 'state', 'conversations', id), id);
  const note = async () =>
    `${(await memory.scopePaths(project)).project}/MEMORY.md`;
  const notes = async () =>
    `${(await memory.scopePaths(project)).project}/notes.md`;
  const git = (...args: string[]) =>
    promisify(execFile)('git', ['-C', project, ...args]);
  /** another conversation's workspace, for publishing to main from outside. */
  const outsider = async (id = randomUUID()) => {
    await mkdir(join(root, 'state', 'conversations', id), { recursive: true });
    const other = workspace(id);
    await other.ensureWorktree();
    await other.scope(project);
    return other;
  };
  /** a second instance continuing the project's conversation, as `witch -c` does. */
  const reopen = async () => {
    const reopened = new Coordinator(store, memory, agents);
    try {
      await reopened.initialize(project, { continue: true });
    } catch (error) {
      await reopened.close();
      throw error;
    }
    return reopened;
  };
  return {
    coordinator,
    store,
    memory,
    hook,
    a,
    b,
    root,
    project,
    workspace,
    note,
    notes,
    git,
    outsider,
    reopen,
    tracked,
    active,
    jobs,
  };
}

/** a conversation whose branch holds an unpublished commit, made after any launch sweep. */
export async function stranded(
  context: Awaited<ReturnType<typeof fixture>>,
  files: Record<string, string>,
  cwd = context.project,
) {
  const { store, workspace } = context;
  const created = await store.create(record(randomUUID(), cwd));
  const id = created.record.id;
  await created.append({ id: 'n', kind: 'notice', text: 'Earlier', cwd });
  const memory = workspace(id);
  await memory.ensureWorktree();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(memory.root, path, '..'), { recursive: true });
    await writeFile(join(memory.root, path), text);
  }
  await memory.commit(`chore(memory): save notes\n\nconversation: ${id}`);
  return { id, files: created, memory };
}

/** each turn's prompt and spell, in the order the agent got them. */
export const turns = (a: FixtureAgent) =>
  a.inputs.map(({ prompt, skill }) => [prompt, skill]);
