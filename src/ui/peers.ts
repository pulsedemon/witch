import type {
  CoordinationSnapshot,
  TaskClaim,
} from '../core/coordination-state.js';
import { presenceStatus } from '../core/coordination-state.js';
import { hyperlink, oneLine, plain } from './links.js';

function referenceTarget(reference: string): string | undefined {
  const match = /^github:([^#]+)#(\d+)$/.exec(reference);
  return match
    ? `https://github.com/${match[1]}/issues/${match[2]}`
    : undefined;
}

export function peerTitle(peer: CoordinationSnapshot['peers'][number]): string {
  const title = oneLine(
    peer.claim?.summary ?? `${peer.presence.title} (unclaimed)`,
  );
  const target = peer.claim?.references.map(referenceTarget).find(Boolean);
  return target ? hyperlink(title, target, peer.presence.cwd) : title;
}

function claimText(claim: TaskClaim): string {
  return [
    plain(claim.summary),
    ...claim.references.map((reference) => {
      const target = referenceTarget(reference);
      return target
        ? hyperlink(reference.slice(7), target, '/')
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
      snapshot.ownClaim ? claimText(snapshot.ownClaim) : 'No task claimed.',
    );
    return sections.join('\n\n');
  }
  for (const { presence, claim } of snapshot.peers) {
    sections.push(
      [
        claim
          ? claimText(claim)
          : `${oneLine(presence.title)}\nUnclaimed\nConversation: ${oneLine(presence.id)}`,
        `${oneLine(presence.agent)} | ${presenceStatus(presence)} | ${oneLine(presence.branch ?? 'No branch')}`,
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
