import type { CoordinationSnapshot } from './coordination-state.js';

export function requiresClaim(snapshot: CoordinationSnapshot): boolean {
  return (
    snapshot.error !== undefined ||
    snapshot.peers.length > 0 ||
    snapshot.reservations.length > 0 ||
    snapshot.unregistered.length > 0
  );
}

export function coordinationStatus(snapshot: CoordinationSnapshot): string {
  return requiresClaim(snapshot)
    ? 'Claim coordination is required. This replaces earlier solo-session instructions. Claim any unclaimed task already underway before further task work.'
    : 'Discovery found no other live session, reservation or unregistered owner in this project. New work needs no claim or pre-task peer query. This replaces earlier claim requirements; task selection and existing ownership still apply.';
}

export function coordinationContext(
  snapshot: CoordinationSnapshot,
  moved: readonly string[],
  turn?: string,
): string {
  return [
    'Session coordination:',
    JSON.stringify(snapshot),
    coordinationStatus(snapshot),
    ...moved,
    ...(snapshot.error
      ? [
          'Coordination is unavailable. Do not start new claimed work until a fresh query succeeds.',
        ]
      : []),
    turn ? `Selection turn: ${turn}` : 'No selection turn is current.',
  ].join('\n');
}

export function coordinationInstructions(
  snapshot: CoordinationSnapshot,
  command: string,
): string {
  const required = requiresClaim(snapshot);
  return [
    `Control command: ${command}`,
    ...(required
      ? [
          'Use --peers --json to inspect sessions; --claim <full GitHub issue/pr URL or task:name> --summary <work> --alias <related reference> to claim. --alias is optional and repeatable.',
        ]
      : []),
    ...(required || snapshot.ownClaim
      ? [
          'Use --release <claim-id> to release owned work. Keep its summary current, pass its ownership context to delegated workers, and release only after the task and its delegated work have ended. A recorded suggestion is owned work too; --cancel-selection removes only its selection ticket.',
        ]
      : []),
    'When asked to choose the next task, run --select-next <selection-turn-id> --json before triage, using the current Selection turn value. If no selection turn is current, do not reuse an earlier value. It waits automatically for your place. Do not claim a generic triage task, end the request because another session is choosing, or ask the user to repeat it.',
    'After position 1 is granted, refresh issues, code and reservations. Reserve your recommendation with --recommend <reference> --selection <ticket-id> --summary <work> [--alias <reference>] before presenting it. A specific-task conflict keeps your place: choose another unreserved task. Other sessions may choose as soon as your recommendation is recorded.',
    'Keep the suggestion reserved while awaiting the user.',
    ...(required
      ? [
          'When the user requests planning, investigation or implementation, use --claim on that reference to promote it. A different named task replaces your suggestion only if its claim succeeds.',
        ]
      : snapshot.ownClaim
        ? [
            'Requested work needs no claim promotion while this project remains solo. When the user replaces a recorded suggestion with different work, release that suggestion first.',
          ]
        : []),
    'Another --select-next releases the old suggestion and joins the tail. Cancel with --cancel-selection <ticket-id> when redirected or when no suitable work remains. Do not infer permission from a failed or timed-out command; query peers to reconcile its result.',
    ...(required
      ? [
          'Before starting a new task, query the other sessions and claim its reference. Claim any unclaimed task already underway before continuing it. For unnumbered work, compare existing task summaries and reuse a matching reference. A claim can move automatically when its idle owner reports an exhausted usage limit that has not reset and has no unresolved memory recovery, running familiars or brews. A returned conflict means stop that task and report its owner and the /task take command the conflict names; do not rename the task to get around the conflict. Refresh before changing scope, including after a steered request.',
        ]
      : []),
  ].join('\n');
}
