import { isFamiliarAction } from '../agents/familiar-report.js';
import type { assignGitHubTask } from './github-assignment.js';
import { recordTaskAssignment } from './github-assignment.js';
import {
  ClaimConflict,
  type CoordinationStore,
  type Ledger,
} from '../persistence/coordination.js';
import type { ControlOutcome, ControlRequest } from '../persistence/control.js';
import type { StateStore } from '../persistence/store.js';
import type { Activation, LedgerView, RequestState } from './coordination.js';
import {
  checkTaskRelease,
  conversationSummarySchema,
  type ClaimOwner,
  type CoordinationSnapshot,
  type SelectionScope,
  type TransferTarget,
} from './coordination-state.js';
import { projectDiscovery, type Discovery } from './discovery.js';
import { checkAnswering, isPeerAction, peerOutcome } from './peer-requests.js';
import {
  isPauseAction,
  pauseRecipients,
  pauseStatuses,
  type Pause,
  type PauseAction,
} from './pauses.js';
import type { Snapshot } from './snapshot.js';
import type { ProcessIdentity } from './state.js';
import {
  awaitTransfer,
  takeReference,
  TransferUnavailable,
} from './task-transfer.js';

export interface DispatchHost {
  readonly registry: CoordinationStore;
  readonly store: StateStore;
  readonly process: ProcessIdentity;
  readonly assign: typeof assignGitHubTask;
  state(): Snapshot | undefined;
  turn(): SelectionScope | undefined;
  presenceFailure(): string | undefined;
  /** records a failed cleanup after the action, as the selection failure. */
  failed(error: unknown): void;
  admit(request?: ControlRequest): Activation;
  readLedger(state?: RequestState): Promise<LedgerView>;
  change<T>(
    state: RequestState | undefined,
    work: (verify: (ledger: Ledger) => Promise<void>) => Promise<T>,
    verify?: (ledger: Ledger) => Promise<void>,
  ): Promise<T>;
  observe(state: RequestState): Promise<Discovery>;
  requestSnapshot(
    active: Activation,
    state: RequestState,
  ): Promise<CoordinationSnapshot>;
  refreshProject(active: Activation, deadline?: number): Promise<void>;
  retireProject(active: Activation, state?: RequestState): Promise<void>;
}

function selectionScope(
  host: DispatchHost,
  active: Activation,
  turn?: string,
): SelectionScope {
  const scope = host.turn();
  if (
    !scope ||
    scope.activation !== active.binding.activation ||
    scope.owner.project !== active.project ||
    (turn !== undefined && scope.turn !== turn)
  )
    throw new Error('This selection turn is no longer current.');
  return scope;
}

/** runs inside SessionCoordination.serialize; every ledger write goes through host.change. */
export async function dispatchControl(
  host: DispatchHost,
  request: ControlRequest,
  human: boolean,
  state: RequestState = {},
): Promise<ControlOutcome> {
  const active = host.admit(request);
  state.deadline = request.deadline;
  let outcome: ControlOutcome | undefined;
  try {
    const action = request.action;
    if (isFamiliarAction(action) || action.kind === 'route')
      throw new Error('This action is answered before dispatch.');
    checkAnswering(host.state()?.answering, action);
    if (action.kind === 'peers') {
      const snapshot = await host.requestSnapshot(active, state);
      if (snapshot.error) throw new Error(snapshot.error);
      return (outcome = { kind: 'peers', snapshot });
    }
    if (action.kind === 'take' && !human)
      throw new Error(
        'Only the user can request an unconditional transfer. Use --claim to request a transfer when the owner is out of usage.',
      );
    if (action.kind === 'release') {
      const claim = (await host.readLedger(state)).ledger.claims.find(
        (entry) => entry.id === action.claim,
      );
      await host.change(
        state,
        (verify) =>
          host.registry.release(
            {
              conversation: active.conversation.id,
              project: claim?.owner.project ?? active.project,
            },
            action.claim,
            request.deadline,
            verify,
          ),
        async () => {
          host.admit(request);
          checkTaskRelease(host.state(), human);
        },
      );
      return { kind: 'released' };
    }
    await host.refreshProject(active, request.deadline);
    await host.retireProject(active, state);
    const owner = {
      conversation: active.conversation.id,
      project: active.project,
    };
    if (isPeerAction(action))
      return await peerOutcome(action, {
        registry: host.registry,
        owner,
        deadline: request.deadline,
        change: (work, verify) => host.change(state, work, verify),
        peers: async (ledger) => {
          host.admit(request);
          return projectDiscovery(
            active.conversation.id,
            active.project,
            await host.observe(state),
            ledger,
          ).peers;
        },
        claims: async () => (await host.readLedger(state)).ledger.claims,
      });
    if (isPauseAction(action))
      return await pauseOutcome(host, request, active, owner, state, action);
    const scope =
      action.kind === 'claim' || action.kind === 'take'
        ? undefined
        : selectionScope(
            host,
            active,
            action.kind === 'select-next' ? action.turn : undefined,
          );
    const verify = async (ledger: Ledger) => {
      // a closing session refuses before its project read and discovery spend the request's deadline
      host.admit(request);
      await host.refreshProject(active, request.deadline);
      const snapshot = projectDiscovery(
        active.conversation.id,
        active.project,
        await host.observe(state),
        ledger,
      );
      host.admit(request);
      if (owner.project !== active.project)
        throw new Error(
          'The project changed. Query peers before claiming again.',
        );
      if (scope && selectionScope(host, active) !== scope)
        throw new Error('This selection turn is no longer current.');
      if (host.presenceFailure()) throw new Error(host.presenceFailure());
      if (snapshot.unregistered.length)
        throw new Error(
          `Restart or close these unregistered Witch sessions before claiming: ${snapshot.unregistered.map((entry) => `${entry.title} (${entry.id}, ${entry.cwd})`).join('; ')}`,
        );
      if (
        snapshot.ownClaim &&
        snapshot.ownClaim.owner.project !== active.project
      )
        throw new Error(
          'Release the existing task in its original project before claiming in this project.',
        );
      if (action.kind === 'select-next') {
        const older = snapshot.peers.filter(
          (peer) => !peer.presence.selectionQueue,
        );
        if (older.length)
          throw new Error(
            `Restart or close these Witch sessions before selecting: ${older.map((peer) => `${peer.presence.title} (${peer.presence.id})`).join('; ')}`,
          );
      }
      if (
        action.kind === 'select-next' ||
        action.kind === 'recommend' ||
        (action.kind === 'claim' && snapshot.ownSelection)
      )
        checkTaskRelease(host.state(), false);
    };
    if (action.kind === 'claim' || action.kind === 'take') {
      const transfer = async (target: TransferTarget) => {
        const { activation } = active.binding;
        const { claim, view } = await awaitTransfer({
          conversation: owner.conversation,
          activation,
          reference: action.input.reference,
          field: target.field,
          deadline: request.deadline,
          request: (expires) =>
            host.change(
              state,
              (check) =>
                host.registry.requestTransfer(
                  owner,
                  target,
                  { activation, process: host.process, expires },
                  request.deadline,
                  check,
                ),
              verify,
            ),
          title: async (id) => (await record(host, id))?.title,
          admit: () => host.admit(),
          read: (deadline) => host.readLedger({ deadline }),
          withdraw: (id) => {
            state.ledger = undefined;
            return host.change(state, (check) =>
              host.registry.withdrawTransfer(
                activation,
                id,
                Date.now() + 1000,
                check,
                target.field,
              ),
            );
          },
        });
        state.ledger = view;
        return { kind: 'claimed' as const, claim };
      };
      if (action.kind === 'take')
        return await transfer({ field: 'transfer', ...action.input });
      let claim;
      try {
        claim = await host.change(
          state,
          (check) =>
            host.registry.claim(
              owner,
              action.input,
              host.process,
              request.deadline,
              check,
            ),
          verify,
        );
      } catch (error) {
        if (!(error instanceof ClaimConflict) || error.claim.suggestion)
          throw error;
        return await transfer({
          field: 'automaticTransfer',
          claim: error.claim,
        });
      }
      return {
        kind: 'claimed',
        ...(await recordTaskAssignment(
          claim,
          active.conversation.cwd,
          request.deadline,
          host.assign,
          (id, references, deadline) =>
            host.change(state, (check) =>
              host.registry.recordAssignment(id, references, deadline, check),
            ),
        )),
      };
    }
    if (action.kind === 'recommend')
      return {
        kind: 'claimed',
        claim: await host.change(
          state,
          (check) =>
            host.registry.recommend(
              scope!,
              action.selection,
              action.input,
              host.process,
              request.deadline,
              check,
            ),
          verify,
        ),
      };
    if (action.kind === 'cancel-selection') {
      await host.change(
        state,
        (check) =>
          host.registry.cancelSelection(
            scope!,
            action.selection,
            request.deadline,
            check,
          ),
        verify,
      );
      return { kind: 'selection-cancelled', selection: action.selection };
    }
    const selection = await host.change(
      state,
      (check) =>
        action.kind === 'select-next'
          ? host.registry.beginSelection(scope!, request.deadline, check)
          : host.registry.selection(
              scope!,
              action.selection,
              request.deadline,
              check,
            ),
      verify,
    );
    return (outcome = {
      kind: 'selection',
      selection,
      snapshot: await host.requestSnapshot(active, state),
    });
  } catch (error) {
    const conflict =
      request.action.kind === 'claim' &&
      error instanceof TransferUnavailable &&
      error.claim
        ? new ClaimConflict(error.claim)
        : error;
    if (!(conflict instanceof ClaimConflict)) throw error;
    const owner = await record(host, conflict.claim.owner.conversation);
    return {
      kind: 'conflict',
      claim: conflict.claim,
      message:
        request.action.kind === 'claim'
          ? `${conflict.message} The user can move it here with /task take ${takeReference(request.action.input, conflict.claim, active.project)} once its owner is idle.`
          : conflict.message,
      ...(owner ? { owner: conversationSummarySchema.parse(owner) } : {}),
    };
  } finally {
    await host
      .retireProject(active, state)
      .catch((error: unknown) => host.failed(error));
    await host.requestSnapshot(active, state).then(
      (snapshot) => {
        if (outcome?.kind === 'peers' || outcome?.kind === 'selection')
          outcome.snapshot = snapshot;
      },
      () => {},
    );
  }
}

async function pauseOutcome(
  host: DispatchHost,
  request: ControlRequest,
  active: Activation,
  owner: ClaimOwner,
  state: RequestState,
  action: PauseAction,
): Promise<ControlOutcome> {
  const { registry } = host;
  const result = (pause: Pause): ControlOutcome => ({
    kind: 'pause',
    pause,
    statuses: pauseStatuses(pause),
  });
  if (action.kind === 'pause-status')
    return result(await registry.pause(owner.conversation, action.pause));
  if (action.kind === 'resume')
    return result(
      await registry.resumePause(
        owner.conversation,
        action.pause,
        request.deadline,
      ),
    );
  const scope = host.turn();
  const turn =
    scope?.activation === active.binding.activation ? scope.turn : undefined;
  const existing = await registry.existingPause(
    owner.conversation,
    turn,
    action.to,
  );
  if (existing) return result(existing);
  const recipients = pauseRecipients(
    action.to,
    owner,
    await host.observe(state),
  );
  return result(
    await registry.issuePause(
      owner,
      turn,
      action.to,
      recipients.map(({ id, project }) => ({ conversation: id, project })),
      request.deadline,
      async () => {
        host.admit(request);
        state.discovery = undefined;
        const { live } = await host.observe(state);
        const closed = recipients.filter(({ id }) => !live.get(id)?.pauses);
        if (closed.length)
          throw new Error(
            `These sessions closed before the pause was recorded: ${closed.map(({ id }) => id).join(', ')}`,
          );
      },
    ),
  );
}

async function record(host: DispatchHost, conversation: string) {
  return (await host.store.records([conversation])).records.find(
    (entry) => entry.id === conversation,
  );
}
