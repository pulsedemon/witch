import type {
  CoordinationSnapshot,
  SelectionState,
  TaskClaim,
} from '../core/coordination-state.js';

import {
  githubReference,
  presenceStatus,
  selectionStatus,
} from '../core/coordination-state.js';

import { hyperlink, oneLine, plain } from './links.js';

function referenceTarget(reference: string): string | undefined {
  const issue = githubReference(reference);

  return issue
    ? `https://github.com/${issue.repository}/issues/${issue.number}`
    : undefined;
}

export function peerTitle(peer: CoordinationSnapshot['peers'][number]): string {
  const title = oneLine(
    peer.claim?.summary ??
      `${peer.presence.title}${peer.selection ? '' : ' (unclaimed)'}`,
  );

  const target = peer.claim?.references.map(referenceTarget).find(Boolean);

  return target ? hyperlink(title, target, peer.presence.cwd) : title;
}

export function peerStatus(
  peer: CoordinationSnapshot['peers'][number],
): string {
  if (peer.selection) return selectionStatus(peer.selection);

  return peer.claim?.suggestion ? 'suggested' : presenceStatus(peer.presence);
}

function selectionText(selection: SelectionState): string {
  return `${selection.position === 1 ? 'Choosing next task' : `Queued #${selection.position} for task selection`}\nSelection: ${oneLine(selection.ticket.id)}`;
}

function claimText(claim: TaskClaim): string {
  return [
    ...(claim.suggestion ? ['Suggested task'] : []),
    plain(claim.summary),
    ...claim.references.map((reference) => {
      const target = referenceTarget(reference);

      return target
        ? hyperlink(reference.slice('github:'.length), target, '/')
        : oneLine(reference.replace(`task:${claim.owner.project}:`, 'task:'));
    }),
    `Claim: ${oneLine(claim.id)}`,
    `Conversation: ${oneLine(claim.owner.conversation)}`,
  ].join('\n');
}

export function coordinationText(
  snapshot: CoordinationSnapshot | undefined,
  mode: 'peers' | 'task',
): string {
  if (!snapshot) return 'Session coordination is unavailable.';

  const sections = snapshot.error
    ? [`Coordination unavailable: ${plain(snapshot.error)}`]
    : [];

  if (mode === 'task') {
    sections.push(
      snapshot.ownSelection
        ? selectionText(snapshot.ownSelection)
        : snapshot.ownClaim
          ? claimText(snapshot.ownClaim)
          : 'No task claimed.',
    );

    return sections.join('\n\n');
  }

  for (const peer of snapshot.peers) {
    const { presence, claim, selection } = peer;

    sections.push(
      [
        claim
          ? claimText(claim)
          : `${oneLine(presence.title)}\n${selection ? selectionText(selection) : 'Unclaimed'}\nConversation: ${oneLine(presence.id)}`,
        `${oneLine(presence.agent)} | ${peerStatus(peer)}${selection || claim?.suggestion ? ` | ${presenceStatus(presence)}` : ''} | ${oneLine(presence.branch ?? 'No branch')}`,
        hyperlink(oneLine(presence.cwd), presence.cwd, presence.cwd),
      ].join('\n'),
    );
  }

  for (const { claim, status } of snapshot.reservations)
    sections.push(`${claimText(claim)}\n${status.replaceAll('-', ' ')}`);

  for (const presence of snapshot.unregistered)
    sections.push(
      [
        `${oneLine(presence.title)} | unregistered`,
        `Conversation: ${oneLine(presence.id)}`,
        hyperlink(oneLine(presence.cwd), presence.cwd, presence.cwd),
        'Restart or close this Witch before claiming new work.',
      ].join('\n'),
    );

  return sections.join('\n\n') || 'No other sessions in this repository.';
}
