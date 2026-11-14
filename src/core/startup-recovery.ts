import type { AgentRegistration } from '../agents/registry.js';
import { errorMessage } from '../errors.js';
import { branchOf } from '../memory/memory.js';
import type { Memory } from '../memory/memory.js';
import { present } from '../persistence/directories.js';
import { LockedElsewhere } from '../persistence/store.js';
import type { ConversationStore, StateStore } from '../persistence/store.js';
import { createConversation } from './state.js';
import type { Conversation } from './state.js';

/** a new conversation in `cwd` continues on the latest conversation's agent while it is installed. */
export async function launchRecord(
  store: StateStore,
  agents: readonly AgentRegistration[],
  cwd: string,
): Promise<Conversation> {
  const [source] = await store.conversations();
  const installed = agents.filter(({ executable }) => executable);

  const agent =
    installed.find(({ adapter }) => adapter.id === source?.agent) ??
    installed[0] ??
    agents[0]!;

  return createConversation(cwd, agent.adapter.id, source);
}

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

    const where = await present(record.cwd).then(
      (found) => (found ? '' : ' (start Witch in its new location)'),
      (error: unknown) => ` (can't be checked: ${errorMessage(error)})`,
    );

    lines.push(`- ${record.title} in ${record.cwd}${where}: ${reason}`);
  }

  return lines.length
    ? `These conversations need attention. Open each from /sessions in its directory:\n${lines.join('\n')}`
    : undefined;
}
