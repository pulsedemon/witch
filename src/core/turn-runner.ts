import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { aborted, errorMessage } from '../agents/stderr.js';
import type { AgentSession, TurnResult } from '../agents/types.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type { ConversationStore } from '../persistence/store.js';
import { endActivity, type Activity } from './activity.js';
import { compactSession, type Compaction } from './compaction.js';
import type { SessionCoordination } from './coordination.js';
import { watchClaimPolicy } from './coordination-policy.js';
import type { CopilotReviewController } from './copilot-review-controller.js';
import type { ReviewBatch } from './copilot-reviews.js';
import { answerNotice, type PeerRequest } from './peer-requests.js';
import {
  preparePeerAnswers,
  recordPeerAnswers,
  peerAnswerOutputSchema,
  type PeerAnswerBatch,
} from './peer-answers.js';
import { nativePrompt, shellCommand, skillCall } from './prompts.js';
import type { Repair } from './pr-repair.js';
import type { Conflict } from './repository.js';
import type { SessionLink } from './session-link.js';
import type { Snapshot } from './snapshot.js';
import {
  recordDelivery,
  unreadRows,
  untitled,
  type ConversationRecord,
  type DisplayUpdate,
} from './state.js';
import type { AccountUsage } from './usage.js';
import {
  compactionThreshold,
  defaultCompactionPercent,
} from './compaction-policy.js';

type TurnKind = 'turn' | 'handoff' | 'answer' | 'review' | 'repair';

interface TurnOptions {
  delivered?: () => void;
  /** the user row is shown, just before the save that records it. */
  showing?: () => void;
  /** the agent never read the prompt, before the unread prompts go back to the queue. */
  unsent?: () => void;
  queued?: boolean;
  requests?: readonly PeerRequest[];
  /** a turn Witch composed, such as a /review correction, adds no user row and doesn't title the conversation. */
  silent?: boolean;
  review?: ReviewBatch;
  repair?: Repair;
  /** a repair refused before native input, with the ownership check's error when it threw. */
  refused?: (error: string) => void;
  /** saved images the turn sends as they are, as a handoff's continuation resends its unfinished turn's. */
  images?: readonly string[];
}

interface TurnHost {
  conversation(): ConversationRecord;
  workspace(): Workspace;
  files(): ConversationStore;
  snapshot(): Snapshot;
  conflict(): Conflict | undefined;
  cancelled(): boolean;
  deliveryHeld(): boolean;
  publish(update: Partial<Snapshot>): void;
  display(update: DisplayUpdate): void;
  notice(text: string): void;
  report(error: unknown): void;
  save(): Promise<void>;
  persist(operation: Promise<void>): void;
  beginActivity(
    kind: Activity['kind'],
    scope?: MemoryScope,
  ): Promise<{ activity: Activity; scope: MemoryScope }>;
  steerQueued(): Promise<void>;
  /** saves the images the prompt's markers name into the conversation. */
  prepareImages(prompt: string): Promise<string[]>;
  /** the native turn ended, so only settlement holds the phase. */
  ended(): void;
  /** sets whether a failed turn holds the queue for the composer. */
  failed(failed: boolean): void;
}

/** runs the open conversation's turns and compactions, and holds the Witch context they have yet to deliver. */
export class TurnRunner {
  private readonly pendingContext = new Map<string, string[]>();

  constructor(
    private readonly host: TurnHost,
    private readonly memory: Memory,
    private readonly link: SessionLink,
    private readonly compaction: Compaction,
    private readonly usage: AccountUsage,
    private readonly copilot: CopilotReviewController,
    private readonly coordination?: SessionCoordination,
  ) {}

  /** admitted automatic turns have already spent their attempt, so only queued user input waits behind delivery holds. */
  async run(
    prompt: string,
    kind: Exclude<TurnKind, 'handoff'>,
    options: TurnOptions,
  ): Promise<TurnResult | undefined> {
    try {
      const scope = await this.memory.scopePaths(this.host.conversation().cwd);
      const session =
        this.link.live(this.host.conversation().agent) ??
        (await this.connectForTurn(scope));
      if (!session) return;
      const usage = session.info.hasHistory
        ? await session.contextUsage()
        : undefined;
      if (
        this.host.cancelled() ||
        session.closed ||
        this.link.session !== session
      )
        return;
      if (options.queued && this.host.deliveryHeld()) return;
      const window = session.usage.contextWindow;
      const compactAt =
        window !== undefined && window > 0
          ? compactionThreshold(window).percent
          : defaultCompactionPercent;
      if (usage !== undefined && usage >= compactAt) {
        this.host.publish({ phase: 'compacting' });
        const compacted = await this.compact(scope);
        if (compacted.status !== 'completed') return compacted;
        this.host.publish({ phase: 'running' });
      }
      if (options.queued && this.host.deliveryHeld()) return;
      return await this.perform(prompt, kind, options, scope);
    } catch (error) {
      this.host.report(error);
    }
  }

  async perform(
    prompt: string,
    kind: TurnKind,
    {
      delivered,
      showing,
      unsent,
      queued = false,
      requests,
      silent,
      review,
      repair,
      refused,
      ...options
    }: TurnOptions = {},
    read?: MemoryScope,
  ): Promise<TurnResult> {
    const conversation = this.host.conversation();
    const answer = kind === 'answer';
    const automatic = answer || kind === 'review' || kind === 'repair';
    if (kind === 'turn') this.host.publish({ completedTurn: undefined });
    const { activity, scope } = await this.host.beginActivity(
      automatic ? 'turn' : kind,
      read,
    );
    const session = await this.connectForTurn(scope);
    if (!session || this.host.cancelled())
      return { status: 'interrupted', text: '' };
    if (!answer) this.coordination?.beginTurn(activity.id);
    let batch: PeerAnswerBatch | undefined;
    try {
      batch = requests && (await preparePeerAnswers(requests));
      this.host.publish({
        subagents: this.host
          .snapshot()
          .subagents.filter(({ status }) => status === 'running'),
      });
      const command = kind === 'turn' ? shellCommand(prompt) : undefined;
      const handoff = conversation.handoff;
      const pendingHandoff =
        !answer && handoff?.activated && handoff.to === conversation.agent
          ? handoff
          : undefined;
      const coordination = await this.coordination?.context(scope.project);
      const pendingContext = automatic
        ? undefined
        : this.pendingContext.get(conversation.id);
      // a resend inside the turn reads the current claim policy and omits the parts that describe output above its prompt
      const context = async (resent = false) =>
        nativePrompt({
          prompt,
          memory: this.memory,
          workspace: this.host.workspace(),
          scope,
          revision: activity.baseRevision,
          reference: conversation.sessions[conversation.agent]!,
          forceContext: resent,
          pendingHandoff,
          coordination: resent
            ? await this.coordination?.context(scope.project)
            : coordination,
          pendingContext: resent ? undefined : pendingContext,
          command: resent ? undefined : command,
          familiarCommand:
            session.familiar && this.coordination
              ? {
                  command: this.coordination.commandPrefixes().familiar,
                  runtime: session.info.agent,
                }
              : undefined,
          merges: this.coordination?.events.mergeEvents(conversation.id),
          requests: batch,
          answers:
            kind === 'turn'
              ? this.coordination?.events.answered(conversation.id)
              : undefined,
          // a conflict repair's instruction carries it, and this context denies authorization to act on it
          conflict: repair && !repair.failed ? undefined : this.host.conflict(),
          usage: this.usage.context(this.host.snapshot().agents),
          reviewWatch: this.copilot.context(),
        });
      let input = await context();
      const owned = review ?? repair;
      if (owned) {
        let refusal: string | undefined;
        try {
          if (
            owned.owner !== conversation.id ||
            !(await this.coordination?.reviews.owns(
              owned.claim,
              owned.pullRequest,
              scope.project,
            ))
          )
            refusal = '';
        } catch (error) {
          if (!repair) throw error;
          refusal = errorMessage(error);
        }
        if (refusal !== undefined) {
          // a stop or restart also fails the check, and leaves the repair attempted
          if (!this.host.cancelled() && !session.closed) refused?.(refusal);
          return { status: 'interrupted', text: '' };
        }
      }
      // from `prompt`, since handoff text in the input can quote old markers.
      // a stop aborts a conversion, and the check below reports it as the stop it is; a stop already made would have
      // aborted an earlier controller, so a cancelled turn starts none
      const images = options.images
        ? [...options.images]
        : kind === 'turn' &&
            !silent &&
            command === undefined &&
            !this.host.cancelled() &&
            !session.closed
          ? await this.host.prepareImages(prompt).catch((error: unknown) => {
              if (this.host.cancelled() || session.closed) return [];
              throw error;
            })
          : [];
      // a stop during an awaited check must prevent native input.
      if (
        this.host.cancelled() ||
        session.closed ||
        (queued && this.host.deliveryHeld())
      )
        return { status: 'interrupted', text: '' };
      if (kind === 'turn' && !silent && conversation.title === untitled)
        conversation.title = prompt.trim().replace(/\s+/g, ' ').slice(0, 80);
      const row = randomUUID();
      if (!silent)
        this.host.display({
          id: row,
          kind: kind === 'turn' ? 'user' : 'notice',
          text: requests
            ? answerNotice(requests)
            : review
              ? `Handling ${review.items.length} Copilot findings on #${review.pullRequest.number}.`
              : repair
                ? repair.failed
                  ? `Repairing failed checks on #${repair.pullRequest.number}: ${repair.failed.map(({ name }) => name).join(', ')}.`
                  : `Repairing the conflict on #${repair.pullRequest.number} with ${repair.pullRequest.base}.`
                : prompt,
          cwd: conversation.cwd,
          ...(images.length ? { images } : {}),
        });
      showing?.();
      this.host.persist(this.host.save());
      if (command !== undefined) delivered?.();
      let result: TurnResult;
      let steering: Promise<void> | undefined;
      let generation = this.link.generation;
      try {
        const ran =
          command === undefined ? undefined : await session.shell(command);
        if (ran && ran.status !== 'completed') result = ran;
        else {
          if (generation !== this.link.generation) input = await context();
          // a listener can stop the turn as its row publishes; the review's batch then stays retryable
          if (this.host.cancelled() || session.closed)
            result = {
              status: 'interrupted',
              text: '',
              ...(review && { inputUnsent: true }),
            };
          else {
            if (!automatic) this.pendingContext.delete(conversation.id);
            generation = this.link.generation;
            const stopResend = this.resendAfterCompaction(
              session,
              async () => (await context(true)).context,
            );
            const sending = session.send(
              input.prompt,
              skillCall(prompt, this.host.snapshot().skills),
              input.context,
              !automatic
                ? 'user'
                : answer
                  ? 'peer-answer'
                  : repair
                    ? 'pr-repair'
                    : 'pr-review',
              batch && {
                outputSchema: peerAnswerOutputSchema,
                requestFile: batch.file,
              },
              images,
            );
            const stopPolicy = watchClaimPolicy(
              this.coordination,
              kind === 'turn' ? coordination?.snapshot : undefined,
              (text) =>
                !this.host.cancelled() && this.link.session === session
                  ? session.steer(text, { contextOnly: true })
                  : Promise.resolve(false),
            );
            // before any await, so these steers go ahead of a prompt sent once the turn runs, whose steer can wait for this turn to end
            if (queued && command === undefined)
              steering = this.host.steerQueued();
            result = await sending.finally(() => {
              stopPolicy?.();
              stopResend();
            });
            if (requests)
              await recordPeerAnswers(result, requests, this.coordination!);
          }
        }
      } catch (error) {
        result = { status: 'failed', text: '', error: errorMessage(error) };
      }
      this.host.ended();
      // first, so the prompts the turn left unread go ahead of those a refused steer gives back
      await steering;
      await this.compaction.busy;
      if (command === undefined && !result.inputUnsent) delivered?.();
      // a `!` command was delivered before it ran
      const back = command === undefined && result.inputUnsent;
      if (back) unsent?.();
      // one publish, so the batch and the prompts it left unread are saved together
      if (back || result.unread?.length)
        this.host.publish({
          queue: [...(result.unread ?? []), ...this.host.snapshot().queue],
        });
      const shown = kind === 'turn' && !silent ? [prompt] : [];
      for (const row of unreadRows(this.host.snapshot().items, shown, result))
        this.host.display({ ...row, text: '', images: [], unread: true });
      if (result.inputUnsent) this.retain(conversation.id, pendingContext);
      this.retain(conversation.id, result.unreadContext);
      await this.finishActivity(activity, this.compaction.failure ?? result);
      if (result.status === 'completed' && !answer) {
        if (generation === this.link.generation) {
          const reference = conversation.sessions[activity.agent]!;
          reference.deliveredRevision = activity.baseRevision;
          reference.deliveredInstructionsRevision = input.instructionsRevision;
          recordDelivery(reference, input);
        }
        if (!automatic && pendingHandoff === conversation.handoff)
          delete conversation.handoff;
      }
      if (kind === 'turn') {
        const { items } = this.host.snapshot();
        // the turn's own row and the steers accepted after it; an unread row's images were cleared above
        const start = items.findIndex(({ id }) => id === row);
        const sent =
          start < 0
            ? []
            : items
                .slice(start)
                .flatMap((item) => (item.kind === 'user' && item.images) || []);
        conversation.lastTurn = {
          id: activity.id,
          status: result.status,
          ...(sent.length ? { images: sent } : {}),
        };
      }
      await this.host.save();
      if (kind === 'turn' && conversation.lastTurn?.status === 'completed')
        this.host.publish({ completedTurn: conversation.lastTurn.id });
      return result;
    } finally {
      try {
        await this.coordination?.endTurn(activity.id);
      } finally {
        if (batch) await rm(batch.file, { force: true });
      }
    }
  }

  /** native hooks block continuation for restoration; other runtimes receive a context-only steer. */
  private resendAfterCompaction(
    session: AgentSession,
    context: () => Promise<string | undefined>,
  ): () => void {
    let stopped = false;
    let restored = false;
    const live = () =>
      !stopped && !this.host.cancelled() && this.link.session === session;
    const stopHook = session.restoreCompactionContext?.(async () => {
      const text = await context();
      if (!live()) return;
      restored = text !== undefined;
      return text;
    });
    const resend = async () => {
      const text = await context();
      if (!text || !live()) return;
      const steer = () =>
        session.steer(
          `Witch context, sent again after the conversation compacted:\n\n${text}`,
          { contextOnly: true },
        );
      // Claude takes no steer until a manual compaction completes
      if (await steer()) return;
      await this.compaction.busy;
      if (live()) await steer();
    };
    const unsubscribe = this.link.onCompacted(() => {
      if (restored) {
        restored = false;
        return;
      }
      void resend().catch((error: unknown) =>
        this.host.notice(errorMessage(error)),
      );
    });
    return () => {
      stopped = true;
      stopHook?.();
      unsubscribe();
    };
  }

  compact(read?: MemoryScope): Promise<TurnResult> {
    return this.compaction.automatic(() => this.compactActivity(read));
  }

  private async compactActivity(read?: MemoryScope): Promise<TurnResult> {
    const { activity, scope } = await this.host.beginActivity('turn', read);
    const result = await compactSession(
      () => this.link.connect(undefined, scope),
      () => this.host.cancelled(),
      (text) => this.host.notice(text),
    );
    this.host.failed(result.status !== 'completed');
    await this.finishActivity(activity, result);
    await this.host.save();
    if (this.host.cancelled()) this.host.failed(true);
    return this.host.cancelled() ? { status: 'interrupted', text: '' } : result;
  }

  private async finishActivity(
    activity: Activity,
    result: TurnResult,
  ): Promise<void> {
    const conversation = this.host.conversation();
    const completed = result.status === 'completed';
    await this.host.files().flush();
    if (!completed) {
      this.host.notice(result.error ?? 'Turn interrupted');
      if (result.status === 'failed') this.host.failed(true);
    }
    await endActivity(this.host.workspace(), conversation, activity, completed);
    if (completed) this.usage.others(activity.agent, conversation.cwd);
  }

  private async connectForTurn(scope?: MemoryScope) {
    try {
      return await this.link.connect(this.host.conversation().agent, scope);
    } catch (error) {
      if (!this.host.cancelled() || !aborted(error)) throw error;
    }
  }

  retain(id: string, context?: readonly string[]): void {
    if (!context?.length) return;
    const pending = this.pendingContext.get(id) ?? [];
    this.pendingContext.set(id, [...pending, ...context]);
  }

  forget(id: string): void {
    this.pendingContext.delete(id);
  }
}
