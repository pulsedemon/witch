import { randomUUID } from 'node:crypto';
import { errorMessage } from '../agents/stderr.js';
import { projectKey } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import { formerPaths, readLedger, within } from '../persistence/directories.js';
import type { Ledger } from '../persistence/directories.js';
import type { Workspace } from '../memory/workspace.js';
import { memoryAttribution } from './prompts.js';
import type { ConversationRecord } from './state.js';

export type Activity = NonNullable<ConversationRecord['activity']>;

/**
 * the ledger of moved directories with the keys the path-keyed project holding `cwd` had at its earlier paths, or why
 * the ledger couldn't be read, which never stops memory from beginning.
 */
async function movedDirectories(
  memory: Memory,
  cwd: string,
  root: string,
): Promise<{ ledger?: Ledger; former: string[]; notices: string[] }> {
  let ledger;
  try {
    ledger = await readLedger(root);
  } catch (error) {
    return {
      former: [],
      notices: [`Could not read moved directories: ${errorMessage(error)}`],
    };
  }
  // only a move to `cwd` or a directory holding it can have carried it, so most turns need no git process here
  const top = ledger.moves.some(({ to }) => within(cwd, to))
    ? await memory.pathScope(cwd)
    : undefined;
  const former = top ? (await formerPaths(ledger, top)).map(projectKey) : [];
  return { ledger, former, notices: [] };
}

/** the notice for notes a begin repointed, with any failure to read the ledger or repoint. */
function repointNotice(
  notices: string[],
  repointed: number,
  failure?: string,
): string | undefined {
  if (repointed)
    notices.push(`Repointed ${repointed} memory note(s) at moved directories.`);
  if (failure) notices.push(failure);
  return notices.join('\n') || undefined;
}

/**
 * records an activity on the conversation from the memory revision it starts at, reading the scope unless the caller
 * already did. `notice` reports notes repointed at moved directories in the state directory `root`.
 */
export async function startActivity(
  workspace: Workspace,
  conversation: ConversationRecord,
  kind: Activity['kind'],
  root: string,
  scope?: MemoryScope,
): Promise<{ activity: Activity; scope: MemoryScope; notice?: string }> {
  scope ??= await workspace.memory.scopePaths(conversation.cwd);
  await workspace.ensureWorktree();
  const { ledger, former, notices } = await movedDirectories(
    workspace.memory,
    conversation.cwd,
    root,
  );
  const begun = await workspace.begin(scope, ledger, former);
  const activity = {
    id: randomUUID(),
    agent: conversation.agent,
    kind,
    baseRevision: begun.revision,
    startedAt: new Date().toISOString(),
  };
  conversation.activity = activity;
  return {
    activity,
    scope,
    notice: repointNotice(notices, begun.repointed, begun.notice),
  };
}

/** adopts the checkout's notes and a path-keyed project's notes from its earlier paths at startup and repoints moved paths; adoption errors and a failed repoint rollback propagate, the rest is a notice. */
export async function adoptMoved(
  workspace: Workspace,
  scope: MemoryScope,
  cwd: string,
  root: string,
): Promise<string | undefined> {
  const { ledger, former, notices } = await movedDirectories(
    workspace.memory,
    cwd,
    root,
  );
  const adopted = await workspace.adoptCheckout(scope, ledger, former);
  return repointNotice(notices, adopted.repointed, adopted.notice);
}

/** commits a completed activity's notes; an unfinished one stays recorded while it left notes uncommitted. */
export async function endActivity(
  workspace: Workspace,
  conversation: ConversationRecord,
  activity: Activity,
  completed: boolean,
): Promise<void> {
  if (completed)
    await workspace.commit(
      `chore(memory): save ${activity.agent} notes\n\n${memoryAttribution(conversation.id, activity.id)}`,
    );
  else if (await workspace.isDirty()) return;
  delete conversation.activity;
}
