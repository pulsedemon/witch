import { statSync } from 'node:fs';
import type { Memory } from '../../memory/memory.js';
import { checkDeadline } from '../../persistence/coordination.js';
import type {
  CoordinationStore,
  Ledger,
} from '../../persistence/coordination.js';
import { identifyProcesses, sameProcess } from '../../persistence/process.js';
import type { StateStore } from '../../persistence/store.js';
import {
  conversationSummarySchema,
  selectionStates,
} from './coordination-state.js';
import type {
  CoordinationSnapshot,
  SessionPresence,
} from './coordination-state.js';

export interface Discovery {
  revision: number;
  live: Map<string, SessionPresence>;
  opened: Awaited<ReturnType<StateStore['openConversations']>>;
  records: Awaited<ReturnType<StateStore['records']>>['records'];
  unregistered: Map<string, CoordinationSnapshot['unregistered']>;
}

interface Sources {
  registry: CoordinationStore;
  store: StateStore;
  memory: Memory;
}

/** `held` is the caller's own publishing activation, whose lock it already holds. */
export async function discover(
  { registry, store, memory }: Sources,
  revision: number,
  held: string | undefined,
  deadline?: number,
): Promise<Discovery> {
  const timeout = deadline === undefined ? undefined : checkDeadline(deadline);

  const reads = [
    registry.presences(),
    store.openConversations(undefined, { timeout }),
  ] as const;

  await Promise.allSettled(reads);
  const [presences, opened] = await Promise.all(reads);
  const { records, unreadable } = await store.records([...opened.keys()]);

  if (unreadable.length)
    throw new Error(
      `Cannot determine session ownership: ${unreadable.map((entry) => entry.file).join(', ')}`,
    );

  const candidates = new Map<string, SessionPresence>();

  for (const record of records) {
    const presence = presences.find((entry) => entry.id === record.id);

    if (opened.has(record.id) && presence?.cwd === record.cwd)
      candidates.set(record.id, presence);
  }

  const activations = await registry.activeActivations(
    [...candidates.values()].flatMap(({ activation }) =>
      activation === held ? [] : [activation],
    ),
    {
      timeout: deadline === undefined ? undefined : checkDeadline(deadline),
    },
  );

  if (held) activations.add(held);

  const processes = await identifyProcesses(
    [...candidates.values()].flatMap((presence) =>
      activations.has(presence.activation) ? [presence.process.pid] : [],
    ),
    {
      timeout: deadline === undefined ? undefined : checkDeadline(deadline),
    },
  );

  const live = new Map<string, SessionPresence>();
  const unregistered = new Map<string, CoordinationSnapshot['unregistered']>();

  for (const record of records) {
    const holder = opened.get(record.id);

    if (!holder) continue;

    const presence = candidates.get(record.id);

    if (
      presence &&
      activations.has(presence.activation) &&
      sameProcess(processes.get(presence.process.pid), presence.process)
    ) {
      live.set(record.id, presence);

      continue;
    }

    // a current Witch opening, reconnecting or closing this conversation
    if (holder.coordinated) continue;

    try {
      const { project } = await memory.scopePaths(
        record.cwd,
        deadline === undefined
          ? undefined
          : AbortSignal.timeout(checkDeadline(deadline)),
      );

      const summaries = unregistered.get(project) ?? [];
      summaries.push(conversationSummarySchema.parse(record));
      unregistered.set(project, summaries);
    } catch (error) {
      const { code, syscall } = error as NodeJS.ErrnoException;

      if (code !== 'ENOENT' || syscall !== 'realpath') throw error;
    }
  }

  return { revision, live, opened, records, unregistered };
}

/** one conversation's view of discovery and the ledger within a project. */
export function projectDiscovery(
  conversation: string,
  project: string,
  discovery: Discovery,
  { claims, selections }: Ledger,
): CoordinationSnapshot {
  const { live, opened } = discovery;
  const positions = selectionStates(selections);

  const ownSelection = positions.find(
    (state) => state.ticket.owner.conversation === conversation,
  );

  const ownClaim = claims.find(
    (claim) => claim.owner.conversation === conversation,
  );

  const projectClaims = claims.filter(
    (claim) =>
      claim.owner.project === project &&
      claim.owner.conversation !== conversation,
  );

  const peers = [...live.values()]
    .filter(
      (presence) =>
        presence.project === project && presence.id !== conversation,
    )
    .sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id))
    .map((presence) => ({
      presence,
      selection: positions.find(
        (state) => state.ticket.owner.conversation === presence.id,
      ),
      claim: projectClaims.find(
        (claim) => claim.owner.conversation === presence.id,
      ),
    }));

  const reservations: CoordinationSnapshot['reservations'] =
    projectClaims.flatMap((claim) => {
      const presence = live.get(claim.owner.conversation);

      if (presence?.project === project) return [];

      return [
        {
          claim,
          status: presence
            ? 'owner-outside-project'
            : opened.has(claim.owner.conversation)
              ? 'unknown'
              : 'unattended',
        },
      ];
    });

  return {
    peers,
    ownClaim,
    ownSelection,
    reservations,
    unregistered: discovery.unregistered.get(project) ?? [],
  };
}

export function configStamp(file: string | undefined): string {
  if (!file) return 'none';

  try {
    const { mtimeNs, ino, size } = statSync(file, { bigint: true });

    return `${mtimeNs}:${ino}:${size}`;
  } catch {
    return 'missing';
  }
}
