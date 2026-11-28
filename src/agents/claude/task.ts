import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mergeCasts } from '../familiar-report.js';
import type { FamiliarProgress } from '../familiar-report.js';
import { errorMessage } from '../../errors.js';
import { claudeTitle } from './tool-title.js';
import { skillCasts } from './spells.js';
import { fallbackModel, reportedModel } from './models.js';
import { RateLimit } from './limits.js';
import type { Cast, ExhaustedLimit } from '../types.js';

const frame = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  agent_id: z.string().optional(),
});

const init = z.object({
  session_id: z.string().min(1),
  model: z.string().min(1),
});

const modelChange = z.object({
  direction: z.enum(['retry', 'revert', 'sticky']),
  scope: z.enum(['session', 'local']).optional(),
  original_model: z.string().min(1),
  fallback_model: z.string().min(1),
});

const sessionState = z.object({
  state: z.enum(['idle', 'running', 'requires_action']),
});

const assistant = z.object({
  session_id: z.string(),
  message: z.object({
    model: z.string().min(1),
    content: z.array(z.object({ type: z.string() }).passthrough()),
  }),
});

// RateLimit reads the SDK's own shape; the status is what decides a rejection
const rateLimitEvent = z.object({
  rate_limit_info: z.object({ status: z.string() }).passthrough(),
});

const tool = z.object({ id: z.string(), name: z.string(), input: z.unknown() });

const castContent = z.object({
  message: z.object({ content: z.array(z.unknown()) }),
});

const result = z.object({
  session_id: z.string(),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  permission_denials: z.array(
    z.object({
      tool_name: z.string(),
      tool_use_id: z.string(),
      tool_input: z.record(z.string(), z.unknown()),
    }),
  ),
});

interface Answer {
  readonly text: string;
  readonly model?: string;
}

/**
 * every native result adds to the report. ordinary familiars save the latest successful nonempty answer because
 * a background task can start a turn after it. only the child's exit can finish the task.
 */
export class ClaudeTask {
  private identity?: z.infer<typeof init>;
  private readonly tools = new Set<string>();
  private spells?: Cast[];
  private activity?: string;
  private readonly reports: string[] = [];
  private final?: Answer;
  private latest?: Answer;
  private readonly denials: string[] = [];
  private draftModel?: string;
  /** the current turn's latest text, its report if the turn ends without a result. */
  private draft = '';
  private success = false;
  private receivedResult = false;
  private failure?: string;
  private readonly rateLimit = new RateLimit<object>();
  /** stands for the current native turn, so a rejection without a reset time or window speaks only for the turn it arrived in. */
  private turn: object = {};
  /** the current turn has activity and no result yet. */
  private open = false;
  private rejected?: ExhaustedLimit;

  constructor(
    private readonly cwd: string,
    private readonly emit: (progress: FamiliarProgress) => void,
    private readonly planReview = false,
  ) {}

  message(value: unknown): void {
    try {
      const message = frame.parse(value);

      const nested =
        message.parent_tool_use_id != null || message.agent_id !== undefined;

      // a nested frame's tool calls aren't this task's, but the spells its own familiars cast are
      if (message.type === 'assistant' && this.addCasts(value) && nested)
        this.emit(this.progress());

      if (nested) return;

      if (
        this.planReview &&
        (message.type === 'assistant' ||
          message.type === 'result' ||
          (message.type === 'system' &&
            message.subtype === 'session_state_changed')) &&
        !message.session_id
      )
        throw new Error(
          `Claude did not identify the session for ${message.subtype === 'session_state_changed' ? 'a state event' : `its ${message.type} event`}.`,
        );

      if (this.identity && message.session_id !== this.identity.session_id)
        return;

      if (message.type === 'system' && message.subtype === 'init') {
        const identity = init.parse(value);
        const changed = identity.model !== this.identity?.model;
        this.identity = identity;

        if (changed) this.emit(this.progress());
      } else if (
        message.type === 'system' &&
        message.subtype === 'model_refusal_fallback'
      ) {
        const change = modelChange.parse(value);
        const model = fallbackModel(change);

        if (!this.identity || model === undefined) return;

        if (model !== this.identity.model) {
          this.identity = { ...this.identity, model };
          this.emit(this.progress());
        }
      } else if (
        message.type === 'system' &&
        message.subtype === 'session_state_changed'
      ) {
        const state = sessionState.safeParse(value);

        if (!state.success && this.planReview) throw state.error;

        if (state.data && state.data.state !== 'idle') this.open = true;
      } else if (message.type === 'rate_limit_event') {
        // only advisory: a frame of another shape is skipped rather than failing the task
        const event = rateLimitEvent.safeParse(value).data;

        if (event)
          this.rateLimit.report(
            event.rate_limit_info as SDKRateLimitInfo,
            this.turn,
          );

        this.open = true;
      } else if (message.type === 'assistant') {
        this.open = true;

        if (!this.identity)
          throw new Error('Claude activity arrived before initialization.');

        const {
          message: { model, content },
        } = assistant.parse(value);

        const observed = reportedModel(model);

        const changed =
          observed !== undefined && observed !== this.identity.model;

        if (changed) this.identity = { ...this.identity, model: observed };

        const previousTools = this.tools.size;

        for (const block of content) {
          if (block.type === 'tool_use') {
            const use = tool.parse(block);

            if (this.tools.has(use.id)) continue;

            this.tools.add(use.id);
            this.activity = claudeTitle(use.name, use.input, this.cwd).title;
            this.emit(this.progress());
          }
        }

        if (changed && this.tools.size === previousTools)
          this.emit(this.progress());

        const text = content
          .filter((block) => block.type === 'text')
          .map((block) => z.string().parse(block.text))
          .join('\n');

        if (text) {
          this.draft = text;
          this.draftModel = observed;
        }
      } else if (message.type === 'result') {
        const finished = result.parse(value);

        if (finished.subtype === 'success' && finished.result === undefined)
          throw new Error('Claude returned a success result without a report.');

        this.receivedResult = true;
        this.success = finished.subtype === 'success' && !finished.is_error;

        const denials = finished.permission_denials.map(
          (denial) =>
            `Permission denied: ${claudeTitle(denial.tool_name, denial.tool_input, this.cwd).title}`,
        );

        this.denials.push(...denials);

        this.reports.push(
          finished.result ?? finished.errors?.join('\n') ?? this.draft,
          ...denials,
        );

        if (this.success) {
          const text = finished.result!;

          this.latest = {
            text,
            model: this.planReview
              ? text === this.draft
                ? this.draftModel
                : undefined
              : (this.draftModel ?? this.identity?.model),
          };

          if (text) this.final = this.latest;

          this.rateLimit.clear();
          this.rejected = undefined;
        } else this.rejected = this.rejection();

        this.turn = {};
        this.open = false;
        this.draft = '';
        this.draftModel = undefined;
      }
    } catch (error) {
      this.failed(`Invalid Claude task stream: ${errorMessage(error)}`);
    }
  }

  get answer(): string {
    return this.final?.text ?? '';
  }

  /** plan review uses the latest result, including an empty result, once its turn closes. */
  get latestAnswer() {
    return this.open ? undefined : this.latest;
  }

  get pendingExhaustion() {
    return this.open ? this.rejection() : undefined;
  }

  get permissionDenials(): readonly string[] {
    return this.denials;
  }

  failed(message: string): void {
    this.failure ??= message;
  }

  closed(code: number | null, signal: NodeJS.Signals | null): FamiliarProgress {
    const reason =
      this.failure ??
      (signal
        ? `Claude task stopped (${signal}).`
        : code !== 0
          ? `Claude exited with code ${code}.`
          : !this.identity
            ? 'Claude did not report its native model.'
            : !this.receivedResult
              ? 'Claude exited without a final result.'
              : !this.success
                ? 'Claude task failed.'
                : undefined);

    // a CLI that dies after a rejection confirms it as a failed result would
    const exhausted =
      !signal && reason
        ? this.open
          ? this.rejection()
          : this.rejected
        : undefined;

    return {
      ...this.progress(),
      ...(!signal && !reason && this.final && { model: this.final.model }),
      status: signal ? 'stopped' : reason ? 'failed' : 'completed',
      report: [...this.reports, this.draft, reason]
        .filter(Boolean)
        .join('\n\n'),
      ...(exhausted && { exhausted }),
    };
  }

  private rejection(): ExhaustedLimit | undefined {
    return (
      this.identity && this.rateLimit.rejection(this.turn, this.identity.model)
    );
  }

  private progress(): FamiliarProgress {
    return {
      status: 'running',
      model: this.identity?.model,
      tools: this.tools.size,
      activity: this.activity,
      ...(this.spells ? { spells: this.spells } : {}),
    };
  }

  /** returns whether the frame cast a spell not seen before. */
  private addCasts(value: unknown): boolean {
    const content = castContent.safeParse(value).data?.message.content ?? [];
    const spells = mergeCasts(this.spells, skillCasts(content));

    if (spells) this.spells = spells;

    return !!spells;
  }
}
