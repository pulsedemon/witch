import { z } from 'zod';
import { mergeCasts } from '../familiar-report.js';
import type { FamiliarProgress } from '../familiar-report.js';
import { errorMessage } from '../../errors.js';
import { claudeTitle } from './tool-title.js';
import { skillCasts } from './spells.js';
import type { Cast } from '../types.js';

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

const assistant = z.object({
  session_id: z.string(),
  message: z.object({
    model: z.string().min(1),
    content: z.array(z.object({ type: z.string() }).passthrough()),
  }),
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

/**
 * every native result adds to the report, since a finished background task can start a turn after the answer; only
 * the child's exit can finish the task.
 */
export class ClaudeTask {
  private identity?: z.infer<typeof init>;
  private readonly tools = new Set<string>();
  private spells?: Cast[];
  private activity?: string;
  private readonly reports: string[] = [];
  /** the current turn's latest text, its report if the turn ends without a result. */
  private draft = '';
  private success = false;
  private receivedResult = false;
  private failure?: string;

  constructor(
    private readonly cwd: string,
    private readonly emit: (progress: FamiliarProgress) => void,
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

        if (!this.identity || change.scope === 'local') return;

        const model =
          change.direction === 'revert'
            ? change.original_model
            : change.fallback_model;

        if (model !== this.identity.model) {
          this.identity = { ...this.identity, model };
          this.emit(this.progress());
        }
      } else if (message.type === 'assistant') {
        if (!this.identity)
          throw new Error('Claude activity arrived before initialization.');

        const {
          message: { model, content },
        } = assistant.parse(value);

        const changed =
          model !== '<synthetic>' && model !== this.identity.model;

        if (changed) this.identity = { ...this.identity, model };

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

        if (text) this.draft = text;
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

        this.reports.push(
          finished.result ?? finished.errors?.join('\n') ?? this.draft,
          ...denials,
        );

        this.draft = '';
      }
    } catch (error) {
      this.failed(`Invalid Claude task stream: ${errorMessage(error)}`);
    }
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

    return {
      ...this.progress(),
      status: signal ? 'stopped' : reason ? 'failed' : 'completed',
      report: [...this.reports, this.draft, reason]
        .filter(Boolean)
        .join('\n\n'),
    };
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
