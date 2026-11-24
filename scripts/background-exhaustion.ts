import { performance } from 'node:perf_hooks';
import type { AgentEvent } from '../src/agents/types.js';
import type { WireFrame } from '../test/fixtures/native-wire.js';

import type { NativeRuntime } from '../src/agents/native-check/artifact.js';

export type Status = 'passed' | 'blocked' | 'failed' | 'incomplete';

type Observation =
  | { kind: 'wire'; runtime: NativeRuntime; process: number; frame: WireFrame }
  | {
      kind: 'event';
      runtime: NativeRuntime;
      session: string;
      event: AgentEvent;
    }
  | { kind: 'fact'; name: string; value: unknown };

export type Evidence = Observation & {
  sequence: number;
  at: number;
  elapsed: number;
};

type Wire = Extract<Evidence, { kind: 'wire' }>;

export interface OrdinaryTurn {
  input: Wire;
  started: Wire;
  result: Wire;
  idle: Wire;
  session: string;
  uuid: string;
}

export interface Expectation {
  marker: string;
  queued: string;
  reply: string;
  refusalModel: string;
  withBrew: boolean;
}

export interface Condition {
  name: string;
  status: 'verified' | 'unverified' | 'failed';
  evidence: number[];
}

export interface AcceptanceResult {
  status: Status;
  reason: string;
  conditions: Condition[];
  cleanup: 'verified' | 'incomplete';
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function field(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((parent, key) => object(parent)[key], value);
}

function texts(value: unknown): string {
  if (Array.isArray(value)) return value.map(texts).join('\n');

  const row = object(value);

  return typeof row.text === 'string'
    ? row.text
    : texts(Array.isArray(row.content) ? row.content : []);
}

function message(entry: Wire): Record<string, unknown> {
  return object(entry.frame.message);
}

function successful(entry: Wire): boolean {
  const row = message(entry);

  return (
    row.type === 'result' && row.subtype === 'success' && row.is_error === false
  );
}

export class EvidenceJournal {
  readonly entries: Evidence[] = [];
  private readonly startedAt = performance.now();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly write: (entry: Evidence) => void = () => {}) {}

  record(observation: Observation): number {
    const entry = {
      ...structuredClone(observation),
      sequence: this.entries.length + 1,
      at: Date.now(),
      elapsed: performance.now() - this.startedAt,
    };

    this.entries.push(entry);
    this.write(entry);

    for (const listener of this.listeners) listener();

    return entry.sequence;
  }

  fact(name: string, value: unknown): number {
    return this.record({ kind: 'fact', name, value });
  }

  facts(name: string): Extract<Evidence, { kind: 'fact' }>[] {
    return this.entries.filter(
      (entry): entry is Extract<Evidence, { kind: 'fact' }> =>
        entry.kind === 'fact' && entry.name === name,
    );
  }

  wires(
    runtime: NativeRuntime,
    predicate: (row: Record<string, unknown>, entry: Wire) => boolean,
    after = 0,
    process?: number,
  ): Wire[] {
    return this.entries.filter(
      (entry): entry is Wire =>
        entry.kind === 'wire' &&
        entry.runtime === runtime &&
        entry.sequence > after &&
        (process === undefined || entry.process === process) &&
        predicate(message(entry), entry),
    );
  }

  waitFor(
    label: string,
    predicate: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.listeners.delete(check);
        signal.removeEventListener('abort', abort);

        if (error) reject(error);
        else resolve();
      };

      const abort = () =>
        finish(
          new Error(`Unverified barrier: ${label}`, { cause: signal.reason }),
        );

      const check = () => {
        try {
          if (predicate()) finish();
        } catch (error) {
          finish(error);
        }
      };

      this.listeners.add(check);
      signal.addEventListener('abort', abort, { once: true });

      if (signal.aborted) abort();
      else check();
    });
  }

  accepted(
    marker: string,
  ): { input: Wire; started: Wire; uuid: string; session: string } | undefined {
    const input = this.wires(
      'claude',
      (row, entry) =>
        entry.frame.direction === 'client' &&
        row.type === 'user' &&
        texts(row.message).includes(marker),
    )[0];

    if (!input) return;

    const uuid = message(input).uuid;

    if (typeof uuid !== 'string') return;

    const started = this.wires(
      'claude',
      (row, entry) =>
        entry.frame.direction === 'server' &&
        row.type === 'command_lifecycle' &&
        row.command_uuid === uuid &&
        row.state === 'started',
      input.sequence,
      input.process,
    )[0];

    const session = started && message(started).session_id;

    return started && typeof session === 'string'
      ? { input, started, uuid, session }
      : undefined;
  }

  ordinary(marker: string): OrdinaryTurn | undefined {
    const accepted = this.accepted(marker);

    if (!accepted) return;

    const { input, started, uuid, session } = accepted;

    const result = this.wires(
      'claude',
      (row, entry) =>
        successful(entry) &&
        row.session_id === session &&
        Array.isArray(row.user_message_uuids) &&
        row.user_message_uuids.includes(uuid),
      started.sequence,
      input.process,
    )[0];

    const completed = this.wires(
      'claude',
      (row) =>
        row.type === 'command_lifecycle' &&
        row.session_id === session &&
        row.command_uuid === uuid &&
        row.state === 'completed',
      started.sequence,
      input.process,
    )[0];

    if (!result || !completed) return;

    const idle = this.wires(
      'claude',
      (row) =>
        row.type === 'system' &&
        row.subtype === 'session_state_changed' &&
        row.session_id === session &&
        row.state === 'idle',
      Math.max(result.sequence, completed.sequence),
      input.process,
    )[0];

    return idle ? { ...accepted, result, idle } : undefined;
  }

  task(command: string): Wire | undefined {
    const call = this.wires('claude', (row, entry) => {
      if (entry.frame.direction !== 'server' || row.type !== 'assistant')
        return false;

      const content = field(row, 'message', 'content');

      return (
        Array.isArray(content) &&
        content.some(
          (block) =>
            field(block, 'type') === 'tool_use' &&
            field(block, 'name') === 'Bash' &&
            field(block, 'input', 'command') === command,
        )
      );
    })[0];

    if (!call) return;

    const blocks = field(message(call), 'message', 'content') as unknown[];

    const block = blocks.find(
      (item) => field(item, 'input', 'command') === command,
    );

    return this.wires(
      'claude',
      (row) =>
        row.type === 'system' &&
        row.subtype === 'task_started' &&
        row.tool_use_id === field(block, 'id') &&
        row.is_backgrounded === true,
      call.sequence,
      call.process,
    )[0];
  }

  followup(task: Wire, after: number): Wire | undefined {
    const identity = message(task);

    const notification = this.wires(
      'claude',
      (row) =>
        row.type === 'system' &&
        row.subtype === 'task_notification' &&
        row.session_id === identity.session_id &&
        row.task_id === identity.task_id &&
        row.run_id === identity.run_id &&
        row.status === 'completed',
      after,
      task.process,
    )[0];

    if (!notification) return;

    const running = this.wires(
      'claude',
      (row) =>
        row.type === 'system' &&
        row.subtype === 'session_state_changed' &&
        row.session_id === identity.session_id &&
        row.state === 'running',
      notification.sequence,
      task.process,
    )[0];

    if (!running) return;

    const result = this.wires(
      'claude',
      (row, entry) =>
        successful(entry) &&
        row.session_id === identity.session_id &&
        Array.isArray(row.user_message_uuids) &&
        row.user_message_uuids.length === 0,
      running.sequence,
      task.process,
    )[0];

    if (!result) return;

    return this.wires(
      'claude',
      (row) =>
        row.type === 'system' &&
        row.subtype === 'session_state_changed' &&
        row.session_id === identity.session_id &&
        row.state === 'idle',
      result.sequence,
      task.process,
    )[0];
  }

  settlement(after: number): Evidence | undefined {
    return this.facts('snapshot').find((entry) => {
      const state = object(entry.value);

      return (
        entry.sequence > after &&
        field(state, 'conversation', 'agent') === 'claude' &&
        state.nativeRunning === false &&
        Array.isArray(state.backgroundCommands) &&
        state.backgroundCommands.length === 0 &&
        Array.isArray(state.subagents) &&
        !state.subagents.some((row) => field(row, 'status') === 'running')
      );
    });
  }

  finish(expected: Expectation): AcceptanceResult {
    const conditions: Condition[] = [];

    const check = (
      name: string,
      entries: (Evidence | undefined)[],
      failed = false,
    ) => {
      const verified = entries.length > 0 && entries.every(Boolean);

      conditions.push({
        name,
        status: failed ? 'failed' : verified ? 'verified' : 'unverified',
        evidence: entries.flatMap((entry) => (entry ? [entry.sequence] : [])),
      });
    };

    const ordinary = this.ordinary(expected.marker);

    check(
      'ordinary input, result, acknowledgements and idle',
      ordinary
        ? [ordinary.input, ordinary.started, ordinary.result, ordinary.idle]
        : [],
    );

    const token = this.facts('token')[0];
    const value = token && field(token.value, 'value');
    const original = this.facts('original')[0];

    check(
      'independent token after acceptance',
      [ordinary?.started, token, original],
      typeof value === 'string' &&
        !!token &&
        !!ordinary &&
        (token.sequence <= ordinary.started.sequence ||
          (JSON.stringify(original?.value) ?? '').includes(value)),
    );

    const reports = this.facts('report');

    check(
      'successful real familiar reports and later native follow-up',
      reports.flatMap((report) => {
        const data = object(report.value);

        const task =
          typeof data.command === 'string'
            ? this.task(data.command)
            : undefined;

        const completion = this.entries.find(
          (entry) =>
            entry.kind === 'event' &&
            entry.event.type === 'subagent' &&
            entry.event.subagent.run === data.run &&
            entry.event.subagent.status === 'completed',
        );

        const followup =
          task && completion && this.followup(task, completion.sequence);

        const completed =
          completion?.kind === 'event' &&
          completion.event.type === 'subagent' &&
          completion.event.subagent.report?.includes(String(value))
            ? completion
            : undefined;

        return [
          report,
          data.code === 0 &&
          data.signal === null &&
          typeof data.text === 'string' &&
          typeof value === 'string' &&
          data.text.includes(value)
            ? completed
            : undefined,
          followup,
        ];
      }),
    );

    const selection = this.facts('selected')[0];

    const modelRequest =
      ordinary &&
      this.wires(
        'claude',
        (row) =>
          row.type === 'control_request' &&
          field(row, 'request', 'subtype') === 'set_model' &&
          field(row, 'request', 'model') === expected.refusalModel,
        ordinary.idle.sequence,
        ordinary.input.process,
      )[0];

    const modelResponse =
      modelRequest &&
      this.wires(
        'claude',
        (row) =>
          row.type === 'control_response' &&
          field(row, 'response', 'request_id') ===
            message(modelRequest).request_id &&
          field(row, 'response', 'subtype') === 'success',
        modelRequest.sequence,
        modelRequest.process,
      )[0];

    check('native and persisted refusal-model selection agree', [
      modelRequest,
      modelResponse,
      selection &&
      field(selection.value, 'model') === expected.refusalModel &&
      field(selection.value, 'persisted') === expected.refusalModel
        ? selection
        : undefined,
    ]);

    const trigger = this.facts('trigger')[0];

    const exhausted = this.entries.find(
      (entry) =>
        entry.kind === 'event' &&
        entry.runtime === 'claude' &&
        entry.event.type === 'exhausted' &&
        entry.session === ordinary?.session &&
        entry.sequence > (trigger?.sequence ?? Infinity),
    );

    const failure =
      ordinary &&
      trigger &&
      this.wires(
        'claude',
        (row) =>
          row.type === 'result' &&
          row.session_id === ordinary.session &&
          row.is_error === true &&
          Array.isArray(row.user_message_uuids) &&
          row.user_message_uuids.length === 0,
        trigger.sequence,
        ordinary.input.process,
      )[0];

    const nativeIdle =
      failure &&
      ordinary &&
      this.wires(
        'claude',
        (row) =>
          row.type === 'system' &&
          row.subtype === 'session_state_changed' &&
          row.session_id === ordinary.session &&
          row.state === 'idle',
        failure.sequence,
        failure.process,
      )[0];

    check('confirmed native background refusal', [
      trigger,
      failure,
      exhausted,
      nativeIdle,
    ]);

    const submission = this.facts('queued')[0];

    check('queued input submitted after exhaustion admission', [
      exhausted,
      submission && submission.sequence > (exhausted?.sequence ?? Infinity)
        ? submission
        : undefined,
    ]);

    const injection = this.wires(
      'codex',
      (row, entry) =>
        entry.frame.direction === 'client' &&
        row.method === 'thread/inject_items' &&
        typeof value === 'string' &&
        texts(field(row, 'params', 'items')).includes(value) &&
        texts(field(row, 'params', 'items')).includes(expected.marker),
      exhausted?.sequence ?? Infinity,
    )[0];

    const thread = injection && field(message(injection), 'params', 'threadId');
    const injected = injection && this.response(injection);

    const continuation =
      injected &&
      this.wires(
        'codex',
        (row, entry) =>
          entry.frame.direction === 'client' &&
          row.method === 'turn/start' &&
          field(row, 'params', 'threadId') === thread &&
          texts(field(row, 'params', 'input')).startsWith('Continue the task'),
        injected.sequence,
        injection.process,
      )[0];

    const continued = continuation && this.response(continuation);
    const turn = continued && field(message(continued), 'result', 'turn', 'id');

    const answered =
      typeof turn === 'string' && injection
        ? this.answer(injection.process, thread, turn, [String(value)])
        : undefined;

    check(
      'acknowledged native destination context and completed token answer',
      [injection, injected, continuation, continued, answered],
      !!injection &&
        texts(field(message(injection), 'params', 'items')).includes(
          expected.queued,
        ),
    );

    const queued = this.wires(
      'codex',
      (row, entry) =>
        entry.frame.direction === 'client' &&
        row.method === 'turn/start' &&
        texts(field(row, 'params', 'input')) === expected.queued,
    );

    const deliveries = this.wires(
      'codex',
      (row, entry) =>
        entry.frame.direction === 'client' &&
        (row.method === 'turn/start' ||
          row.method === 'turn/steer' ||
          row.method === 'thread/inject_items') &&
        texts(
          field(
            row,
            'params',
            row.method === 'thread/inject_items' ? 'items' : 'input',
          ),
        ).includes(expected.queued),
    );

    const queuedResponse = queued[0] && this.response(queued[0]);

    const queuedTurn =
      queuedResponse && field(message(queuedResponse), 'result', 'turn', 'id');

    const replied =
      queued[0] && typeof queuedTurn === 'string'
        ? this.answer(
            queued[0].process,
            field(message(queued[0]), 'params', 'threadId'),
            queuedTurn,
            [expected.reply],
          )
        : undefined;

    const sourceLeak = this.wires(
      'claude',
      (row, entry) =>
        entry.frame.direction === 'client' &&
        row.type === 'user' &&
        texts(row.message).includes(expected.queued),
    );

    check(
      'queued prompt completes once after continuation, never on source',
      [answered, queued[0], queuedResponse, replied],
      deliveries.length > 1 ||
        deliveries[0] !== queued[0] ||
        sourceLeak.length > 0 ||
        (!!queued[0] &&
          !!injection &&
          (queued[0].process !== injection.process ||
            field(message(queued[0]), 'params', 'threadId') !== thread)) ||
        (!!queued[0] && !!answered && queued[0].sequence <= answered.sequence),
    );

    const before = this.facts('claim-before')[0];
    const admission = this.facts('admission')[0];
    const after = this.facts('claim-after')[0];

    check(
      'conversation, source outcome and claim survive',
      [before, admission, after],
      !!before &&
        !!admission &&
        !!after &&
        (typeof field(before.value, 'id') !== 'string' ||
          !Array.isArray(field(before.value, 'references')) ||
          field(admission.value, 'id') !== field(before.value, 'id') ||
          JSON.stringify(field(admission.value, 'references')) !==
            JSON.stringify(field(before.value, 'references')) ||
          field(admission.value, 'sourceOutcome') !== 'completed' ||
          JSON.stringify(before.value) !== JSON.stringify(after.value) ||
          field(admission.value, 'conversation') !==
            field(before.value, 'conversation')),
    );

    const settled = exhausted && this.settlement(exhausted.sequence);
    const brew = this.facts('brew-held')[0];

    const connection = this.wires(
      'codex',
      (row, entry) =>
        entry.frame.direction === 'client' &&
        (row.method === 'thread/start' || row.method === 'thread/resume'),
      exhausted?.sequence ?? Infinity,
    )[0];

    check(
      'native and command settlement precede destination connection',
      [settled, nativeIdle, connection, continuation],
      !!connection &&
        ((!!settled && settled.sequence >= connection.sequence) ||
          (!!nativeIdle && nativeIdle.sequence >= connection.sequence)),
    );

    if (expected.withBrew) {
      const done = this.facts('budget-done')[0];
      const ready = this.facts('budget-ready')[0];
      const command = ready && field(ready.value, 'command');
      const task = typeof command === 'string' ? this.task(command) : undefined;

      const notification =
        task &&
        brew &&
        this.wires(
          'claude',
          (row) =>
            row.subtype === 'task_notification' &&
            row.task_id === message(task).task_id &&
            row.run_id === message(task).run_id &&
            row.status === 'completed',
          brew.sequence,
          task.process,
        )[0];

      check(
        'independent brew delays switching and exits naturally',
        [exhausted, brew, done, notification, settled],
        !!brew &&
          !!done &&
          !!settled &&
          (brew.sequence <= (exhausted?.sequence ?? Infinity) ||
            settled.sequence <= brew.sequence ||
            (!!notification && notification.sequence >= settled.sequence) ||
            field(done.value, 'code') !== 0 ||
            field(done.value, 'natural') !== true),
      );
    }

    const cleanup = this.facts('cleanup').at(-1);
    const clean = cleanup?.value === true;
    const stop = this.facts('stop').at(-1);
    const status = field(stop?.value, 'status');

    const broken = conditions.some(
      (condition) => condition.status === 'failed',
    );

    const complete = conditions.every(
      (condition) => condition.status === 'verified',
    );

    return {
      status: !clean
        ? 'incomplete'
        : broken
          ? 'failed'
          : status === 'blocked' ||
              status === 'failed' ||
              status === 'incomplete'
            ? status
            : complete
              ? 'passed'
              : 'incomplete',
      reason: !clean
        ? 'cleanup-unverified'
        : broken
          ? 'acceptance-relationship-failed'
          : stop
            ? String(field(stop.value, 'reason'))
            : complete
              ? 'all-conditions-verified'
              : 'acceptance-evidence-missing',
      conditions,
      cleanup: clean ? 'verified' : 'incomplete',
    };
  }

  private response(request: Wire): Wire | undefined {
    return this.wires(
      'codex',
      (row, entry) =>
        entry.frame.direction === 'server' &&
        row.id === message(request).id &&
        row.result !== undefined &&
        row.error === undefined,
      request.sequence,
      request.process,
    )[0];
  }

  private answer(
    process: number,
    thread: unknown,
    turn: string,
    values: string[],
  ): Wire | undefined {
    return this.wires(
      'codex',
      (row) => {
        if (
          row.method !== 'turn/completed' ||
          field(row, 'params', 'threadId') !== thread ||
          field(row, 'params', 'turn', 'id') !== turn ||
          field(row, 'params', 'turn', 'status') !== 'completed'
        )
          return false;

        const items = field(row, 'params', 'turn', 'items');

        const text = Array.isArray(items)
          ? items
              .filter((item) => field(item, 'type') === 'agentMessage')
              .map((item) => field(item, 'text'))
              .join('\n')
          : '';

        return values.every((value) => text.includes(value));
      },
      0,
      process,
    )[0];
  }
}
