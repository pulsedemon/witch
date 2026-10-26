import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ControlBinding } from '../persistence/control.js';
import { checkDeadline } from '../persistence/coordination.js';
import { readFamiliarMarker } from './familiar-report.js';
import type {
  FamiliarAction,
  FamiliarMarker,
  FamiliarOutcome,
} from './familiar-report.js';
import type { AgentEvent, Subagent, TaskStatus } from './types.js';

export interface ClaudeTaskControl {
  getTaskOutput(taskId: string): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
}

interface Command {
  id: string;
  run?: string;
  parent?: string;
  description: string;
  background: boolean;
  listed: boolean;
  status: TaskStatus;
  marker?: FamiliarMarker;
  familiar?: { sequence: number; subagent: Subagent };
}

const taskOutput = z.object({ output: z.string() });

/** native task membership owns the brew even after a reported familiar replaces it. */
export class ClaudeCommands {
  private readonly entries = new Map<string, Command>();
  private stopped = false;
  private closing = false;

  constructor(
    private readonly query: ClaudeTaskControl,
    private readonly binding: ControlBinding | undefined,
    private readonly session: () => string,
    private readonly knownParent: (id: string) => boolean,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  receive(message: SDKMessage): void {
    if (
      this.stopped ||
      message.type !== 'system' ||
      message.session_id !== this.session()
    )
      return;
    if (
      message.subtype === 'task_started' &&
      message.task_type === 'local_bash'
    ) {
      this.start({
        id: message.task_id,
        run: message.run_id,
        parent: message.parent_task_id,
        description: message.description,
        background: message.is_backgrounded === true,
      });
    } else if (message.subtype === 'background_tasks_changed') {
      const listed = new Set<string>();
      for (const task of message.tasks) {
        if (task.task_type !== 'local_bash') continue;
        listed.add(task.task_id);
        const entry = this.start({
          id: task.task_id,
          run: task.run_id,
          parent: task.parent_task_id,
          description: task.description,
          background: true,
        });
        if (entry) entry.listed = true;
      }
      for (const entry of this.entries.values())
        if (entry.listed && !listed.has(entry.id)) {
          entry.listed = false;
          this.end(entry, 'stopped');
        }
    } else if (
      message.subtype === 'task_updated' ||
      message.subtype === 'task_notification'
    ) {
      const entry = this.entries.get(message.task_id);
      if (!entry || this.late(entry, message.run_id)) return;
      if (message.subtype === 'task_notification') {
        this.end(entry, message.status);
      } else {
        const { status, is_backgrounded: background } = message.patch;
        if (background && !entry.background) {
          entry.background = true;
          this.publish(entry);
        }
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'killed'
        )
          this.end(entry, status === 'killed' ? 'stopped' : status);
      }
    }
  }

  private late(entry: Command, run: string | undefined): boolean {
    return Boolean(run && entry.run && run !== entry.run);
  }

  private start(
    input: Omit<Command, 'listed' | 'status'>,
  ): Command | undefined {
    const previous = this.entries.get(input.id);
    if (previous?.run && input.run && input.run < previous.run) return;
    if (
      previous &&
      (!input.run || !previous.run || input.run === previous.run)
    ) {
      previous.run ??= input.run;
      previous.parent ??= input.parent;
      if (!previous.background && input.background) {
        previous.background = true;
        this.publish(previous);
      }
      return previous;
    }
    if (previous) this.end(previous, 'stopped');
    const entry: Command = { ...input, listed: false, status: 'running' };
    this.entries.set(entry.id, entry);
    this.publish(entry);
    return entry;
  }

  private publish(entry: Command): void {
    if (!entry.background) return;
    this.emit({
      type: 'command',
      command: {
        id: entry.id,
        description: entry.description,
        status: entry.status,
        ...(entry.familiar ? { familiar: entry.familiar.subagent.id } : {}),
      },
    });
  }

  private end(entry: Command, status: TaskStatus): void {
    if (entry.status !== 'running') return;
    entry.status = status;
    const familiar = entry.familiar;
    if (familiar?.subagent.status === 'running') {
      familiar.subagent = {
        ...familiar.subagent,
        status: status === 'stopped' ? 'stopped' : 'failed',
      };
      this.emit({ type: 'subagent', subagent: familiar.subagent });
    }
    this.publish(entry);
  }

  async report(
    action: FamiliarAction,
    deadline: number,
  ): Promise<FamiliarOutcome> {
    this.admit(deadline);
    if (action.kind === 'familiar-register') {
      for (const entry of this.entries.values()) {
        if (!entry.background || entry.status !== 'running' || entry.marker)
          continue;
        const { output } = taskOutput.parse(
          await this.query.getTaskOutput(entry.id),
        );
        this.admit(deadline);
        if (this.entries.get(entry.id) !== entry || entry.status !== 'running')
          continue;
        for (const line of output.split('\n').slice(0, -1)) {
          const marker = readFamiliarMarker(line);
          if (
            marker?.conversation === this.binding!.conversation &&
            marker.activation === this.binding!.activation
          ) {
            entry.marker = marker;
            break;
          }
        }
      }
    }
    const matches = [...this.entries.values()].filter(
      (entry) => entry.marker?.run === action.run,
    );
    if (matches.length > 1)
      throw new Error('This familiar run belongs to more than one command.');
    const entry = matches[0];
    if (!entry) {
      if (action.kind === 'familiar-register')
        return { kind: 'familiar-pending' };
      throw new Error(
        'The familiar run is not registered in this native session.',
      );
    }
    if (action.kind === 'familiar-register') {
      if (entry.status !== 'running')
        throw new Error('The familiar command has already ended.');
      if (entry.familiar) {
        if (entry.familiar.subagent.name !== action.name)
          throw new Error('The familiar name changed.');
        return { kind: 'familiar-registered' };
      }
      const subagent: Subagent = {
        id: `codex-familiar/${action.run}`,
        run: action.run,
        name: action.name,
        kind: '',
        runtime: 'codex',
        status: 'running',
        tools: 0,
        ...(entry.parent && this.knownParent(entry.parent)
          ? { parent: entry.parent }
          : {}),
      };
      entry.familiar = { sequence: -1, subagent };
      this.emit({ type: 'subagent', subagent });
      this.publish(entry);
      return { kind: 'familiar-registered' };
    }
    const familiar = entry.familiar;
    if (!familiar) throw new Error('The familiar run has not registered.');
    if (action.sequence <= familiar.sequence)
      return { kind: 'familiar-updated' };
    if (entry.status !== 'running' || familiar.subagent.status !== 'running')
      throw new Error('The familiar run has already ended.');
    familiar.sequence = action.sequence;
    familiar.subagent = { ...familiar.subagent, ...action.progress };
    this.emit({ type: 'subagent', subagent: familiar.subagent });
    return { kind: 'familiar-updated' };
  }

  private admit(deadline: number): void {
    checkDeadline(deadline);
    if (this.stopped || this.closing || !this.binding)
      throw new Error('Familiar reporting is unavailable.');
  }

  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(
      [...this.entries.values()]
        .filter((entry) => entry.familiar && entry.status === 'running')
        .map((entry) => this.query.stopTask(entry.id)),
    );
    this.stop();
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) this.end(entry, 'stopped');
  }
}
