import { z } from 'zod';
import { dirname } from 'node:path';
import type { ControlBinding } from '../../persistence/control.js';
import {
  addFamiliar,
  admitFamiliar,
  admitted,
  checkReporting,
  findFamiliar,
  pendingFamiliarVerifications,
  respondFamiliar,
  scanMarkers,
} from '../familiar-report.js';
import { FamiliarRun } from '../familiar-requests.js';
import type {
  FamiliarAction,
  FamiliarOutcome,
  FamiliarSlot,
  MarkerLine,
} from '../familiar-report.js';
import { pages } from './json-rpc.js';
import type { JsonRpc, RpcMessage } from './json-rpc.js';
import { errorMessage } from '../../errors.js';
import type { AgentEvent, BackgroundCommand, UserResponse } from '../types.js';

interface Command {
  threadId: string;
  turnId: string;
  itemId: string;
  processId?: string;
  lookup?: Promise<void>;
  lookupError?: string;
  ended: boolean;
  interrupted?: boolean;
  done?: boolean;
  exited?: boolean;
  command?: BackgroundCommand;
  line: MarkerLine;
  familiars: FamiliarSlot[];
  cleanup?: Promise<void>;
}

export type Notification = {
  method: RpcMessage['method'];
  params: Record<string, unknown>;
  item?: Record<string, unknown>;
};

const commandStatus = z.enum(['completed', 'failed', 'declined']);

const backgroundList = z.object({
  data: z.array(
    z.object({
      itemId: z.string(),
      command: z.string(),
      processId: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullish(),
});

/** one native command owns its brew or reported familiar, including after its turn ends. */
export class CodexCommands {
  get active(): boolean {
    return [...this.entries.values()].some((entry) => !entry.done);
  }
  private readonly entries = new Map<string, Command>();
  private stopped = false;
  private closing = false;
  private finalizing?: Promise<void>;

  constructor(
    private readonly rpc: JsonRpc,
    private readonly binding: ControlBinding | undefined,
    private readonly mainThread: () => string,
    private readonly knownThread: (thread: string) => boolean,
    private readonly interrupted: (thread: string, turn: string) => boolean,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  receive(message: Notification): void {
    if (this.stopped) return;

    const { params, item } = message;

    if (!item && message.method !== 'turn/completed') return;

    if (item && item.type !== 'commandExecution') return;

    const threadId = z.string().parse(params.threadId);

    if (!this.knownThread(threadId)) return;

    if (!item) {
      const { turn } = z
        .object({
          turn: z.object({ id: z.string(), status: z.string().optional() }),
        })
        .parse(params);

      for (const entry of this.entries.values())
        if (entry.threadId === threadId && entry.turnId === turn.id) {
          entry.ended = true;

          entry.interrupted =
            turn.status === 'interrupted' ||
            this.interrupted(threadId, turn.id);
        }

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
        line: { partial: '', discarding: false },
        familiars: [],
      });

      return;
    }

    const entry = this.entries.get(key);

    if (!entry || entry.done) return;

    const familiars = admitted(entry.familiars);

    if (
      params.turnId !== entry.turnId &&
      familiars.some((familiar) => familiar.planReview)
    )
      return;

    const status =
      entry.command && !familiars.length
        ? commandStatus.parse(item.status)
        : undefined;

    entry.done = true;

    if (familiars.length) {
      const stopped =
        this.closing ||
        entry.interrupted ||
        this.interrupted(entry.threadId, entry.turnId);

      for (const familiar of familiars)
        familiar.end(
          stopped ? 'stopped' : item.exitCode === 0 ? 'completed' : 'failed',
        );

      // the parent reads a real exit from Codex's record, and once read its process id can be reused.
      // codex never lists an exited record, so skipping cleanup also spares a list read
      entry.exited = typeof item.exitCode === 'number' && item.exitCode >= 0;

      if (!entry.exited) void this.collect(entry);
    } else {
      if (entry.command)
        this.emit({
          type: 'command',
          command: {
            ...entry.command,
            status: status === 'completed' ? 'completed' : 'failed',
          },
        });

      if (!entry.familiars.length) this.entries.delete(key);
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

    scanMarkers(entry.line, delta, this.binding, (marker) =>
      addFamiliar(entry.familiars, marker),
    );
  }

  report(action: FamiliarAction, deadline: number): FamiliarOutcome {
    checkReporting(deadline, !this.stopped && !this.closing && !!this.binding);
    const found = findFamiliar(this.entries.values(), action);

    if (!found) return { kind: 'familiar-pending' };

    const { entry, slot } = found;

    return admitFamiliar(
      slot,
      entry.done === true,
      action,
      (action) => {
        if (!entry.processId) {
          if (entry.lookupError) throw new Error(entry.lookupError);

          entry.lookup ??= this.readHandle(entry)
            .catch((error: unknown) => {
              entry.lookupError = errorMessage(error);
            })
            .finally(() => {
              entry.lookup = undefined;
            });

          return { kind: 'familiar-pending' };
        }

        return new FamiliarRun(
          action,
          this.emit,
          entry.threadId === this.mainThread() ? undefined : entry.threadId,
          dirname(dirname(this.binding!.directory)),
        );
      },
      (run) => {
        if (entry.command)
          this.emit({
            type: 'command',
            command: {
              ...entry.command,
              familiar: run.subagent.id,
            },
          });
      },
    );
  }

  respond(id: string, response: UserResponse): boolean {
    return respondFamiliar(this.entries.values(), id, response);
  }

  async close(): Promise<void> {
    this.closing = true;

    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => admitted(entry.familiars).length && !entry.exited)
        .map((entry) => this.collect(entry)),
    );

    await this.stop();
  }

  stop(): Promise<void> | undefined {
    if (this.stopped) return this.finalizing;

    this.stopped = true;
    this.finalizing = pendingFamiliarVerifications(this.entries.values());

    for (const entry of this.entries.values()) {
      const familiars = admitted(entry.familiars);

      for (const familiar of familiars) familiar.end('stopped');

      if (!familiars.length && entry.command)
        this.emit({
          type: 'command',
          command: { ...entry.command, status: 'stopped' },
        });
    }

    this.entries.clear();

    return this.finalizing;
  }

  /**
   * completion and close can both reach one entry; they share its cleanup.
   * codex reuses a freed process id, so only a record it still lists under this item is terminated.
   */
  private collect(entry: Command): Promise<void> {
    entry.cleanup ??= this.terminate(entry).catch((error: unknown) => {
      if (this.stopped) return;

      const names = admitted(entry.familiars)
        .map(({ subagent }) => subagent.name)
        .join(', ');

      this.emit({
        type: 'notice',
        text: `Witch could not confirm cleanup of ${names}: ${errorMessage(error)}`,
      });
    });

    return entry.cleanup;
  }

  private async terminate(entry: Command): Promise<void> {
    // a real exit can be recorded while the list read is pending; its record is the parent's to read
    if (!(await this.listed(entry)) || this.stopped || entry.exited) return;

    const result = await this.rpc.request(
      'thread/backgroundTerminals/terminate',
      { threadId: entry.threadId, processId: entry.processId },
    );

    if (!z.object({ terminated: z.boolean() }).parse(result).terminated)
      throw new Error(
        'The native terminal was not found; check remaining jobs.',
      );
  }

  private async listed(entry: Command): Promise<boolean> {
    for await (const data of this.backgroundPages(entry.threadId))
      if (
        data.some(
          ({ itemId, processId }) =>
            itemId === entry.itemId && processId === entry.processId,
        )
      )
        return true;

    return false;
  }

  /** approval starts omit the handle and suppress the later native start; the list retains the same item id. */
  private async readHandle(entry: Command): Promise<void> {
    for await (const data of this.backgroundPages(entry.threadId)) {
      if (
        this.stopped ||
        this.closing ||
        entry.done ||
        this.entries.get(`${entry.threadId}/${entry.itemId}`) !== entry
      )
        return;

      const terminal = data.find((item) => item.itemId === entry.itemId);

      if (terminal) {
        if (!terminal.processId)
          throw new Error('The native terminal has no process handle.');

        entry.processId = terminal.processId;

        return;
      }
    }
  }

  private backgroundPages(threadId: string) {
    return pages(
      this.rpc,
      'thread/backgroundTerminals/list',
      { threadId },
      backgroundList,
    );
  }

  private async readBackground(threadId: string): Promise<void> {
    const candidates = [...this.entries].filter(
      ([, entry]) =>
        entry.threadId === threadId &&
        entry.ended &&
        !entry.done &&
        !entry.command &&
        !admitted(entry.familiars).length,
    );

    if (!candidates.length) return;

    try {
      const listed = new Map<string, string>();

      for await (const data of this.backgroundPages(threadId)) {
        if (this.stopped || this.closing) return;

        for (const { itemId, command } of data)
          listed.set(`${threadId}/${itemId}`, command);
      }

      for (const [id, entry] of candidates) {
        const description = listed.get(id);

        if (
          description === undefined ||
          this.entries.get(id) !== entry ||
          entry.command ||
          admitted(entry.familiars).length ||
          entry.done
        )
          continue;

        entry.command = { id, description, status: 'running' };
        this.emit({ type: 'command', command: entry.command });
      }
    } catch (error) {
      if (!this.stopped && !this.closing)
        this.emit({
          type: 'notice',
          text: `Witch could not list Codex's background commands: ${errorMessage(error)}`,
        });
    }
  }
}
