import { z } from 'zod';
import { object } from './codex-config.js';
import { completedTurn, itemTitle, turnId, untooled } from './codex-items.js';
import { castSkills } from './codex-spells.js';
import { mergeCasts } from './familiar-report.js';
import type { Notification } from './codex-commands.js';
import type { JsonRpc } from './json-rpc.js';
import type { SessionOptions, Subagent } from './types.js';

export class CodexFamiliars {
  private readonly subagents = new Map<string, Subagent>();
  private readonly subagentModels = new Map<
    string,
    { configured?: string; rerouted?: string }
  >();

  constructor(
    private readonly rpc: JsonRpc,
    private readonly options: Pick<SessionOptions, 'cwd' | 'onEvent'>,
    private readonly mainThread: () => string,
    private readonly closing: () => boolean,
  ) {}

  has(thread: string): boolean {
    return this.subagents.has(thread);
  }

  get active(): boolean {
    return [...this.subagents.values()].some(
      (agent) => agent.status === 'running',
    );
  }

  /** ahead of the familiar filters, so a cast from a familiar's earlier turn or unknown thread still counts. */
  cast(
    message: Notification,
    threadId: string | undefined,
    index: ReadonlyMap<string, string>,
  ): void {
    if (!message.item) return;

    const turn = String(message.params.turnId);

    for (const { path, name } of castSkills(message.item, index)) {
      const cast = {
        id: `${threadId ?? this.mainThread()}/${turn}/${path}`,
        name,
      };

      const subagent = threadId && this.subagents.get(threadId);
      const spells = subagent && mergeCasts(subagent.spells, [cast]);

      if (!subagent) this.options.onEvent({ type: 'spell', cast });
      else if (spells) this.subagent({ ...subagent, spells });
    }
  }

  /** a thread's next turn can start before its last turn's items and end arrive, which then belong to no run. */
  receive(message: Notification, threadId: string): void {
    const subagent = this.subagents.get(threadId);
    const { params, item } = message;

    if (subagent && message.method === 'thread/settings/updated') {
      const configured = z
        .string()
        .parse(object.parse(params.threadSettings).model);

      const identity = { ...this.subagentModels.get(threadId), configured };

      this.subagentModels.set(threadId, identity);

      this.subagent({ ...subagent, model: identity.rerouted ?? configured });

      return;
    }

    if (subagent && message.method === 'model/rerouted') {
      if (params.turnId !== subagent.run) return;

      const rerouted = z.string().parse(params.toModel);

      this.subagentModels.set(threadId, {
        ...this.subagentModels.get(threadId),
        rerouted,
      });

      this.subagent({ ...subagent, model: rerouted });

      return;
    }

    if (subagent && item) {
      if (subagent.run !== undefined && params.turnId !== subagent.run) return;

      const type = z.string().parse(item.type);

      if (type === 'agentMessage') {
        if (
          message.method === 'item/completed' &&
          typeof item.text === 'string'
        )
          this.subagent({ ...subagent, report: item.text });
      } else if (message.method === 'item/started' && !untooled.includes(type))
        this.subagent({
          ...subagent,
          activity: itemTitle(type, item, this.options.cwd).title,
          tools: (subagent.tools ?? 0) + 1,
        });

      return;
    }

    if (
      message.method !== 'turn/started' &&
      message.method !== 'turn/completed'
    )
      return;

    // shown before a completion parses, so a malformed one still lists the thread
    if (!subagent || message.method === 'turn/started') {
      // a new turn is a new run, so it starts without the last one's activity, tool count and report
      const { id, parent, name, kind } = subagent ?? {
        id: threadId,
        parent: undefined,
        name: 'agent',
        kind: '',
      };

      const run = turnId.safeParse(message.params).data?.turn.id;
      const configured = this.subagentModels.get(threadId)?.configured;

      this.subagentModels.set(threadId, { configured });

      this.subagent({
        id,
        ...(parent === undefined ? {} : { parent }),
        name,
        kind,
        runtime: 'codex',
        ...(configured ? { model: configured } : {}),
        status: 'running',
        ...(run ? { run } : {}),
      });

      void this.readSubagent(threadId);
    }

    if (message.method === 'turn/completed') {
      const { turn } = completedTurn.parse(params);
      const current = this.subagents.get(threadId)!;

      if (current.run !== undefined && turn.id !== current.run) return;

      this.subagent({
        ...current,
        status:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'interrupted'
              ? 'stopped'
              : 'failed',
      });
    }
  }

  private async readSubagent(threadId: string): Promise<void> {
    const run = this.subagents.get(threadId)!.run;
    const identity = this.subagentModels.get(threadId);

    try {
      const { thread } = z
        .object({
          thread: z.object({
            parentThreadId: z.string().nullable(),
            agentRole: z.string().nullable(),
            model: z.string().nullish(),
            source: z.object({
              subAgent: z.object({
                thread_spawn: z.object({ agent_path: z.string() }),
              }),
            }),
          }),
        })
        .parse(await this.rpc.request('thread/read', { threadId }));

      const current = this.subagents.get(threadId);

      if (this.closing() || !current || current.run !== run) return;

      // settings and reroutes received during the read supersede its model snapshot
      const model =
        this.subagentModels.get(threadId) === identity && thread.model
          ? thread.model
          : undefined;

      if (model) this.subagentModels.set(threadId, { configured: model });

      const parent =
        thread.parentThreadId === this.mainThread()
          ? undefined
          : (thread.parentThreadId ?? undefined);

      const name = thread.source.subAgent.thread_spawn.agent_path
        .split('/')
        .at(-1)!
        .replaceAll('_', ' ');

      const kind = thread.agentRole ?? '';

      if (
        current.parent === parent &&
        current.name === name &&
        current.kind === kind &&
        (!model || current.model === model)
      )
        return;

      this.subagent({
        ...current,
        ...(model ? { model } : {}),
        parent,
        name,
        kind,
      });
    } catch {
      // the subagent keeps its defaults
    }
  }

  private subagent(subagent: Subagent): void {
    this.subagents.set(subagent.id, subagent);

    this.options.onEvent({ type: 'subagent', subagent });
  }
}
