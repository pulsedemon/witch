import { main } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type { editInVSCode } from './editor.js';
import { memoryAttribution } from './prompts.js';
import type { Recovery } from './snapshot.js';
import type { ConversationRecord } from './state.js';

/** the revision one memory UI action reads, resolved once so a publish mid-action can't move it. */
export interface MemoryView {
  revision: string;
  scope: MemoryScope;
  /** the conversation's worktree, for links, while it holds this revision. */
  root?: string;
}

export async function memoryView(
  memory: Memory,
  workspace: Workspace,
  cwd: string,
): Promise<MemoryView> {
  const revision = await memory.resolve(main);
  const scope = await memory.scopePaths(cwd);
  // an idle worktree stays where its last turn left it, behind anything published since
  const linked =
    (await workspace.exists()) && (await workspace.revision()) === revision;
  return { revision, scope, ...(linked ? { root: workspace.root } : {}) };
}

/** applies the user's recovery decision; discarding makes every native session reread memory. */
export async function recoverMemory(
  workspace: Workspace,
  conversation: ConversationRecord,
  kind: Recovery['kind'] | undefined,
  decision: 'accept' | 'discard' | 'keep',
): Promise<void> {
  if (kind === 'conflict') {
    if (decision === 'keep') await workspace.keepMine();
    else if (decision === 'discard') await workspace.discardMine();
    else throw new Error('Keep your memory changes or discard them.');
  } else {
    const origin = conversation.activity;
    const actor =
      origin?.kind === 'memory-edit' ? 'manual' : (origin?.agent ?? 'manual');
    if (decision === 'accept')
      await workspace.commit(
        `chore(memory): recover ${actor} changes\n\n${memoryAttribution(origin ? conversation.id : 'manual', origin?.id ?? 'manual')}`,
      );
    else if (decision === 'discard') await workspace.discardPending();
    else throw new Error('Accept these memory changes or discard them.');
    delete conversation.activity;
  }
  if (decision === 'discard')
    for (const reference of Object.values(conversation.sessions))
      delete reference.deliveredRevision;
}

/** false when an interrupt closed the editor, which leaves the edit uncommitted. */
export async function editNote(
  workspace: Workspace,
  note: string,
  editFile: typeof editInVSCode,
  signal: AbortSignal,
): Promise<boolean> {
  const file = await workspace.prepareNote(note);
  try {
    await editFile(file, signal);
  } catch (error) {
    if (
      !signal.aborted ||
      !(error instanceof Error) ||
      error.name !== 'AbortError'
    )
      throw error;
  }
  if (signal.aborted) return false;
  await workspace.commit('chore(memory): save edited notes');
  return true;
}
