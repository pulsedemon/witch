import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ControlBinding } from '../persistence/control.js';
import { checkDeadline } from '../persistence/coordination.js';
import {
  admitFamiliar,
  boundMarker,
  findFamiliar,
  respondFamiliar,
} from './familiar-report.js';
import { FamiliarRun } from './familiar-requests.js';
import type {
  FamiliarAction,
  FamiliarMarker,
  FamiliarOutcome,
} from './familiar-report.js';
import type { AgentEvent, TaskStatus, UserResponse } from './types.js';

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
  familiar?: FamiliarRun;
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
    entry.familiar?.end(status === 'stopped' ? 'stopped' : 'failed');
    this.publish(entry);
    if (!entry.background) this.entries.delete(entry.id);
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
          const marker = boundMarker(line, this.binding!);
          if (marker) {
            entry.marker = marker;
            break;
          }
        }
      }
    }
    const entry = findFamiliar(this.entries.values(), action);
    if (!entry) return { kind: 'familiar-pending' };
    return admitFamiliar(
      entry,
      entry.status !== 'running',
      action,
      (action) =>
        new FamiliarRun(
          action,
          this.emit,
          entry.parent && this.knownParent(entry.parent)
            ? entry.parent
            : undefined,
        ),
      () => this.publish(entry),
    );
  }

  respond(id: string, response: UserResponse): boolean {
    return respondFamiliar(this.entries.values(), id, response);
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
    this.entries.clear();
  }
}
