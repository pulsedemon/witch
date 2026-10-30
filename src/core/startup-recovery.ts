import { errorMessage } from '../agents/stderr.js';
import { branchOf, exists } from '../memory/memory.js';
import type { Memory } from '../memory/memory.js';
import { missingConversationDirectories } from '../persistence/directory-recovery.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { quote } from '../shell.js';

export async function recoverConversations(
  store: StateStore,
  memory: Memory,
  skip: string | undefined,
): Promise<string | undefined> {
  const { records, unreadable } = await store.records();
  const ahead = new Set(await memory.unpublished());
  const lines = unreadable.map(
    ({ file, error }) => `- ${file} can't be read: ${error}`,
  );
  const listed = new Set(records.map(({ id }) => id));
  for (const id of ahead)
    if (!listed.has(id))
      lines.push(`- ${branchOf(id)} has unpublished memory but no state`);
  for (const record of records) {
    if (
      record.id === skip ||
      (!record.process && !record.activity && !ahead.has(record.id))
    )
      continue;
    let reason: string | undefined;
    // close() rethrows a save failure the catch already reported
    const problem = (error: unknown) => {
      reason ??= errorMessage(error);
    };
    let files: ConversationStore | undefined;
    try {
      files = await store.claim(record.id);
      const workspace = memory.workspace(files.directory, record.id);
      let pending = false;
      if (await workspace.branchExists()) {
        await workspace.ensureWorktree();
        pending = await workspace.isDirty();
        if (pending) reason = 'unfinished memory changes';
        else if ((await workspace.publish()) !== 'published')
          reason = 'memory conflicts with another conversation';
      }
      if (!pending && files.record.activity) {
        delete files.record.activity;
        await files.save(files.record);
      }
    } catch (error) {
      if (!(error instanceof LockedElsewhere)) problem(error);
    } finally {
      await files?.close().catch(problem);
    }
    if (!reason) continue;
    const gone = !(await exists(record.cwd));
    lines.push(
      `- ${record.title} in ${record.cwd}${gone ? ' (recover this directory first)' : ''}: ${reason}`,
    );
  }
  return lines.length
    ? `These conversations need attention. Open each from /sessions in its directory:\n${lines.join('\n')}`
    : undefined;
}

/** a launch notice for saved conversations whose directories are gone, or undefined when none are. */
export async function missingDirectoryNotice(
  store: StateStore,
): Promise<string | undefined> {
  try {
    const missing = await missingConversationDirectories(store);
    if (!missing.length) return undefined;
    return [
      'Saved conversations refer to missing directories. From each replacement directory, preview recovery with:',
      ...missing.map(
        ({ cwd, conversations }) =>
          `${conversations} conversation(s) in ${cwd}\nwitch --state-dir ${quote(store.root)} --recover-directory ${quote(cwd)}`,
      ),
    ].join('\n');
  } catch (error) {
    return `Could not inspect missing conversation directories: ${errorMessage(error)}`;
  }
}
