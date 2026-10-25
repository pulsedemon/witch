import { z } from 'zod';
import type { ControlBinding } from '../persistence/control.js';
import { checkDeadline } from '../persistence/coordination.js';
import { readFamiliarMarker } from './familiar-report.js';
import type {
  FamiliarAction,
  FamiliarOutcome,
  FamiliarMarker,
} from './familiar-report.js';
import type { JsonRpc, RpcMessage } from './json-rpc.js';
import { errorMessage } from './stderr.js';
import type { AgentEvent, BackgroundCommand, Subagent } from './types.js';

interface Command {
  threadId: string;
  turnId: string;
  itemId: string;
  processId?: string;
  ended: boolean;
  done?: boolean;
  command?: BackgroundCommand;
  partial: string;
  discarding?: boolean;
  marker?: FamiliarMarker;
  familiar?: { sequence: number; subagent: Subagent };
  cleanup?: Promise<void>;
}

const commandStatus = z.enum(['completed', 'failed', 'declined']);
const backgroundList = z.object({
  data: z.array(z.object({ itemId: z.string(), command: z.string() })),
});

/** one native command owns its brew or reported familiar, including after its turn ends. */
export class CodexCommands {
  private readonly entries = new Map<string, Command>();
  private stopped = false;

  constructor(
    private readonly rpc: JsonRpc,
    private readonly binding: ControlBinding | undefined,
    private readonly mainThread: () => string,
    private readonly knownThread: (thread: string) => boolean,
    private readonly interrupted: (thread: string, turn: string) => boolean,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  receive(message: {
    method: RpcMessage['method'];
    params: Record<string, unknown>;
    item?: Record<string, unknown>;
  }): void {
    if (this.stopped) return;
    const { params, item } = message;
    if (!item && message.method !== 'turn/completed') return;
    if (item && item.type !== 'commandExecution') return;
    const threadId = z.string().parse(params.threadId);
    if (!this.knownThread(threadId)) return;
    if (!item) {
      const { turn } = z
        .object({ turn: z.object({ id: z.string() }) })
        .parse(params);
      for (const entry of this.entries.values())
        if (entry.threadId === threadId && entry.turnId === turn.id)
          entry.ended = true;
      void this.readBackground(threadId);
      return;
    }
    const itemId = z.string().parse(item.id);
    const key = `${threadId}/${itemId}`;
    if (message.method === 'item/started') {
      this.entries.set(key, {
        threadId,
        turnId: z.string().parse(params.turnId),
        itemId,
        processId:
          typeof item.processId === 'string' ? item.processId : undefined,
        ended: false,
        partial: '',
      });
      return;
    }
    const entry = this.entries.get(key);
    if (!entry || entry.done) return;
    const status = commandStatus.parse(item.status);
    entry.done = true;
    if (entry.familiar) {
      const subagent = entry.familiar.subagent;
      if (subagent.status === 'running') {
        entry.familiar.subagent = {
          ...subagent,
          status: this.interrupted(entry.threadId, entry.turnId)
            ? 'stopped'
            : 'failed',
        };
        this.emit({ type: 'subagent', subagent: entry.familiar.subagent });
      }
      void this.collect(entry);
    } else {
      if (entry.command)
        this.emit({
          type: 'command',
          command: {
            ...entry.command,
            status: status === 'completed' ? 'completed' : 'failed',
          },
        });
      if (!entry.marker) this.entries.delete(key);
    }
  }

  output(params: unknown): void {
    if (!this.binding || this.stopped) return;
    const parsed = z
      .object({
        threadId: z.string(),
        turnId: z.string(),
        itemId: z.string(),
        delta: z.string(),
      })
      .safeParse(params);
    if (!parsed.success) return;
    const { threadId, turnId, itemId, delta } = parsed.data;
    const entry = this.entries.get(`${threadId}/${itemId}`);
    if (
      !entry ||
      entry.done ||
      entry.turnId !== turnId ||
      !this.knownThread(threadId)
    )
      return;
    for (const part of delta.split(/(?<=\n)/)) {
      const ends = part.endsWith('\n');
      if (!entry.discarding) {
        entry.partial += part;
        if (entry.partial.length > 4096) {
          entry.partial = '';
          entry.discarding = true;
        } else if (ends) {
          const marker = readFamiliarMarker(entry.partial.trimEnd());
          if (
            marker?.conversation === this.binding.conversation &&
            marker.activation === this.binding.activation
          )
            entry.marker ??= marker;
        }
      }
      if (ends) {
        entry.partial = '';
        entry.discarding = false;
      }
    }
  }

  report(action: FamiliarAction, deadline: number): FamiliarOutcome {
    checkDeadline(deadline);
    if (this.stopped || !this.binding)
      throw new Error('Familiar reporting is unavailable.');
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
      if (entry.familiar) {
        if (entry.familiar.subagent.name !== action.name)
          throw new Error('The familiar name changed.');
        if (entry.done)
          throw new Error('The familiar command has already ended.');
        return { kind: 'familiar-registered' };
      }
      if (entry.done)
        throw new Error('The familiar command has already ended.');
      if (!entry.processId)
        throw new Error(
          'Use a native exec_command with a terminal handle for this review.',
        );
      const subagent: Subagent = {
        id: `claude-review/${action.run}`,
        run: action.run,
        name: action.name,
        kind: '',
        runtime: 'claude',
        status: 'running',
        tools: 0,
        ...(entry.threadId === this.mainThread()
          ? {}
          : { parent: entry.threadId }),
      };
      entry.familiar = { sequence: -1, subagent };
      this.emit({ type: 'subagent', subagent });
      if (entry.command)
        this.emit({
          type: 'command',
          command: { ...entry.command, familiar: subagent.id },
        });
      return { kind: 'familiar-registered' };
    }
    const familiar = entry.familiar;
    if (!familiar) throw new Error('The familiar run has not registered.');
    if (action.sequence <= familiar.sequence)
      return { kind: 'familiar-updated' };
    if (entry.done || familiar.subagent.status !== 'running')
      throw new Error('The familiar run has already ended.');
    familiar.sequence = action.sequence;
    familiar.subagent = { ...familiar.subagent, ...action.progress };
    this.emit({ type: 'subagent', subagent: familiar.subagent });
    return { kind: 'familiar-updated' };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.familiar)
        .map((entry) => this.collect(entry)),
    );
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      if (entry.familiar?.subagent.status === 'running')
        this.emit({
          type: 'subagent',
          subagent: { ...entry.familiar.subagent, status: 'stopped' },
        });
      else if (!entry.familiar && entry.command)
        this.emit({
          type: 'command',
          command: { ...entry.command, status: 'stopped' },
        });
    }
    this.entries.clear();
  }

  private collect(entry: Command): Promise<void> {
    entry.cleanup ??= this.rpc
      .request('thread/backgroundTerminals/terminate', {
        threadId: entry.threadId,
        processId: entry.processId,
      })
      .then((result) => {
        if (!z.object({ terminated: z.boolean() }).parse(result).terminated)
          throw new Error(
            'The native terminal was not found; check remaining jobs.',
          );
      })
      .catch((error: unknown) => {
        if (!this.stopped)
          this.emit({
            type: 'notice',
            text: `Witch could not confirm cleanup of ${entry.familiar!.subagent.name}: ${errorMessage(error)}`,
          });
      });
    return entry.cleanup;
  }

  private async readBackground(threadId: string): Promise<void> {
    const candidates = [...this.entries].filter(
      ([, entry]) =>
        entry.threadId === threadId &&
        entry.ended &&
        !entry.done &&
        !entry.command &&
        !entry.familiar,
    );
    if (!candidates.length) return;
    try {
      const { data } = backgroundList.parse(
        await this.rpc.request('thread/backgroundTerminals/list', { threadId }),
      );
      if (this.stopped) return;
      const listed = new Map(
        data.map(({ itemId, command }) => [`${threadId}/${itemId}`, command]),
      );
      for (const [id, entry] of candidates) {
        const description = listed.get(id);
        if (
          description === undefined ||
          this.entries.get(id) !== entry ||
          entry.command ||
          entry.familiar ||
          entry.done
        )
          continue;
        entry.command = { id, description, status: 'running' };
        this.emit({ type: 'command', command: entry.command });
      }
    } catch (error) {
      if (!this.stopped)
        this.emit({
          type: 'notice',
          text: `Witch could not list Codex's background commands: ${errorMessage(error)}`,
        });
    }
  }
}
