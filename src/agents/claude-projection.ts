import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { commandLifecycle } from './claude-turn.js';
import { acknowledged, skillCasts } from './claude-spells.js';
import { reportedDiff } from './claude-diff.js';
import { claudeTitle } from './tool-title.js';
import { mergeCasts } from './familiar-report.js';
import type { TurnText } from './turn-text.js';
import type { Cast, SessionOptions, Subagent } from './types.js';

export class ClaudeProjection {
  private currentMessage = '';
  private readonly subagents = new Map<string, Subagent>();
  private readonly pendingCasts = new Map<string, string>();
  private readonly workflows = new Set<string>();
  /** the task ids the last live set listed. a foreground familiar is never listed, so only a task listed before can end by leaving it. */
  private listed = new Set<string>();
  private readonly runs = new Map<string, string>();
  /** the message each familiar's report comes from; its later blocks arrive as frames of their own. */
  private readonly reportMessages = new Map<string, string>();

  constructor(
    private readonly options: Pick<
      SessionOptions,
      'cwd' | 'commandPrefixes' | 'onEvent'
    >,
    private readonly messages: () => TurnText | undefined,
    private readonly startedHolder: () => void,
    private readonly settledHolder: () => void,
  ) {}

  hasSubagent(id: string): boolean {
    return this.subagents.has(id);
  }

  pendingCast(id: string, name: string): void {
    this.pendingCasts.set(id, name);
  }

  get holding(): boolean {
    return (
      this.workflows.size > 0 ||
      [...this.subagents.values()].some(({ status }) => status === 'running')
    );
  }

  receive(message: SDKMessage): void {
    if (message.type === 'system') {
      if (
        // ambient tasks are housekeeping, such as forked-skill workers
        message.subtype === 'task_started' &&
        (message.task_type === 'local_agent' ||
          message.task_type === 'local_workflow') &&
        !message.ambient &&
        !this.late(message)
      ) {
        if (message.run_id) this.runs.set(message.task_id, message.run_id);

        // a workflow holds off idle as a familiar does, though its agents never reach the stream
        if (message.task_type === 'local_workflow')
          this.workflows.add(message.task_id);
        else {
          this.subagent({
            id: message.task_id,
            parent: message.parent_task_id,
            name: message.description,
            kind: message.subagent_type ?? '',
            runtime: 'claude',
            status: 'running',
            run: message.run_id,
          });
        }

        this.startedHolder();
      } else if (message.subtype === 'background_tasks_changed') {
        const listed = new Set(message.tasks.map(({ task_id }) => task_id));

        // registry removal or a full output queue can omit the task notification.
        for (const id of this.listed) {
          if (listed.has(id)) continue;

          this.workflows.delete(id);

          const subagent = this.subagents.get(id);

          if (subagent?.status === 'running')
            this.subagent({ ...subagent, status: 'stopped' });
        }

        this.listed = listed;

        this.settledHolder();
      } else if (message.subtype === 'task_notification') {
        if (this.late(message)) return;

        this.workflows.delete(message.task_id);

        const subagent = this.subagents.get(message.task_id);

        if (subagent) this.subagent({ ...subagent, status: message.status });

        this.settledHolder();
      }
    } else if (
      message.type === 'stream_event' &&
      message.parent_tool_use_id === null
    ) {
      const event = message.event;

      if (event.type === 'message_start')
        this.currentMessage = event.message.id;

      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        const text = event.delta.text;
        const id = this.currentMessage;

        this.messages()?.append(id, text);

        this.options.onEvent({ type: 'text', id, text });
      }
    } else if (
      message.type === 'assistant' &&
      message.parent_tool_use_id === null
    ) {
      const id = message.message.id;

      const text = message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      if (text) {
        this.messages()?.replace(id, text);

        this.options.onEvent({ type: 'text', id, text, replace: true });
      }

      for (const block of message.message.content) {
        if (block.type === 'tool_use')
          this.options.onEvent({
            type: 'tool',
            id: block.id,
            ...claudeTitle(
              block.name,
              block.input,
              this.options.cwd,
              this.options.commandPrefixes,
            ),
            text: JSON.stringify(block.input, null, 2),
            done: false,
          });
      }

      this.cast(skillCasts(message.message.content));
    } else if (
      message.type === 'assistant' &&
      !(message.agent_id && this.subagents.has(message.agent_id))
    ) {
      // an ambient worker's or an unattributed nested cast is shown as the main agent's
      this.cast(skillCasts(message.message.content));
    } else if (message.type === 'assistant' && message.agent_id) {
      const subagent = this.subagents.get(message.agent_id)!;
      const observed = message.message.model;

      const model =
        observed && observed !== '<synthetic>' ? observed : subagent.model;

      let { activity, tools = 0, report } = subagent;

      for (const block of message.message.content)
        if (block.type === 'tool_use') {
          activity = claudeTitle(
            block.name,
            block.input,
            this.options.cwd,
          ).title;

          tools++;
        } else if (block.type === 'text') {
          report =
            report &&
            this.reportMessages.get(subagent.id) === message.message.id
              ? `${report}\n${block.text}`
              : block.text;

          this.reportMessages.set(subagent.id, message.message.id);
        }

      const spells = mergeCasts(
        subagent.spells,
        skillCasts(message.message.content),
      );

      if (
        model !== subagent.model ||
        tools !== (subagent.tools ?? 0) ||
        report !== subagent.report ||
        spells
      )
        this.subagent({
          ...subagent,
          model,
          activity,
          tools,
          report,
          ...(spells ? { spells } : {}),
        });
    } else if (
      message.type === 'user' &&
      message.parent_tool_use_id === null &&
      Array.isArray(message.message.content)
    ) {
      // use each result's own report block, replacing result text with its diff.
      const diff = reportedDiff(message.tool_use_result, this.options.cwd);

      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;

        const parts =
          typeof block.content === 'string'
            ? [{ type: 'text' as const, text: block.content }]
            : (block.content ?? []);

        const images: string[] = [];

        const texts = parts.flatMap((part) => {
          if (part.type === 'image' && part.source.type === 'base64') {
            images.push(
              `data:${part.source.media_type};base64,${part.source.data}`,
            );

            return [];
          }

          return [
            part.type === 'text' ? part.text : JSON.stringify(part, null, 2),
          ];
        });

        this.options.onEvent({
          type: 'tool',
          id: block.tool_use_id,
          title: '',
          text: diff ? '' : texts.join('\n'),
          done: true,
          ...(images.length ? { images } : {}),
          ...(diff ? { diff } : {}),
          ...(block.is_error ? { failed: true } : {}),
        });
      }
    }
  }

  private subagent(subagent: Subagent): void {
    this.subagents.set(subagent.id, subagent);

    this.options.onEvent({ type: 'subagent', subagent });
  }

  private cast(casts: Cast[]): void {
    for (const cast of casts) this.options.onEvent({ type: 'spell', cast });
  }

  /** a sent spell counts once Claude starts its input, which can come before init announces lifecycle support. */
  started(message: SDKMessage): void {
    if (!this.pendingCasts.size) return;

    const lifecycle = commandLifecycle.safeParse(message);

    const uuids = lifecycle.success
      ? lifecycle.data.state === 'started'
        ? [lifecycle.data.command_uuid]
        : []
      : (acknowledged.safeParse(message).data?.user_message_uuids ?? []);

    for (const uuid of uuids) {
      const name = this.pendingCasts.get(uuid);

      if (name === undefined) continue;

      this.pendingCasts.delete(uuid);

      this.cast([{ id: uuid, name }]);
    }
  }

  /** run ids sort in the order the runs opened, so a frame naming an earlier run is late. */
  private late({ task_id, run_id }: { task_id: string; run_id?: string }) {
    const run = this.runs.get(task_id);

    return Boolean(run_id && run && run_id < run);
  }
}
