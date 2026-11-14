import type {
  AgentSession,
  AgentStopOptions,
  AnswerInput,
  SessionInfo,
  SessionOptions,
  TurnResult,
} from './types.js';

import { NativeStop } from './shutdown.js';

/** the owner remains connected while a restricted process answers from its history. */
export class AnswerTurn {
  private active?: {
    abort: AbortController;
    session?: AgentSession;
    finished: PromiseWithResolvers<void>;
    cancelled: boolean;
    stop?: AgentStopOptions;
  };

  constructor(
    private readonly options: SessionOptions,
    private readonly connect: (
      options: SessionOptions,
    ) => Promise<AgentSession>,
  ) {}

  get busy(): boolean {
    return this.active !== undefined;
  }

  /** `guard` is the owning session's state, checked before the answer's own. */
  async run(
    guard: { closed: boolean; running: boolean; label: string },
    source: SessionInfo,
    prompt: string,
    context?: string,
    input?: AnswerInput,
  ): Promise<TurnResult> {
    if (guard.closed) throw new Error(`The ${guard.label} session is closed`);

    if (guard.running) throw new Error('This agent is already running');

    if (!input) throw new Error('A peer answer requires its request file.');

    if (this.active) throw new Error('A peer answer is already running.');

    const active = {
      abort: new AbortController(),
      finished: Promise.withResolvers<void>(),
      session: undefined as AgentSession | undefined,
      cancelled: false,
      stop: undefined as AgentStopOptions | undefined,
    };

    this.active = active;

    let result: TurnResult = { status: 'interrupted', text: '' };

    const hidden = new Set<string>();

    try {
      active.session = await this.connect({
        ...this.options,
        resume: source.hasHistory ? source.id : undefined,
        model: source.model,
        effort: source.effort ?? source.nativeEffort,
        answer: { ...input, permissionProfile: source.permissionProfile },
        automaticCompaction: undefined,
        signal: active.abort.signal,
        familiarBinding: undefined,
        onUsageProcess: undefined,
        onShell: undefined,
        onProcess: async (pid) => this.options.onAnswerProcess?.(pid),
        onEvent: (event) => {
          if (event.type === 'tool') {
            if (event.title === 'StructuredOutput') hidden.add(event.id);

            if (hidden.has(event.id)) return;
          }

          if (event.type === 'tool' || event.type === 'notice')
            this.options.onEvent(event);
        },
      });

      if (!active.cancelled)
        result = await active.session.send(prompt, {
          context,
          purpose: 'peer-answer',
        });
    } catch (error) {
      if (!active.cancelled || !(error instanceof NativeStop)) throw error;
    } finally {
      try {
        await active.session?.close(active.stop);
      } finally {
        this.active = undefined;

        active.finished.resolve();
      }
    }

    return active.cancelled ? { status: 'interrupted', text: '' } : result;
  }

  async interrupt(options: AgentStopOptions = {}): Promise<void> {
    const active = this.active;

    if (!active) return;

    active.cancelled = true;

    active.stop = options;

    try {
      if (active.session)
        try {
          await active.session.interrupt(options);
        } catch (error) {
          await active.session.close(options);

          throw error;
        }
      else active.abort.abort(new NativeStop(options));
    } finally {
      await active.finished.promise;
    }
  }
}
