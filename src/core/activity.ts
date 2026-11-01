import { randomUUID } from 'node:crypto';
import type { MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import { memoryAttribution } from './prompts.js';
import type { ConversationRecord } from './state.js';

export type Activity = NonNullable<ConversationRecord['activity']>;

/** records an activity on the conversation from the memory revision it starts at, reading the scope unless the caller already did. */
export async function startActivity(
  workspace: Workspace,
  conversation: ConversationRecord,
  kind: Activity['kind'],
  scope?: MemoryScope,
): Promise<{ activity: Activity; scope: MemoryScope }> {
  scope ??= await workspace.memory.scopePaths(conversation.cwd);
  await workspace.ensureWorktree();
  const activity = {
    id: randomUUID(),
    agent: conversation.agent,
    kind,
    baseRevision: await workspace.begin(scope),
    startedAt: new Date().toISOString(),
  };
  conversation.activity = activity;
  return { activity, scope };
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
