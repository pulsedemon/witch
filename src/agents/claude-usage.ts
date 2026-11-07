import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { promptlessQuery } from './claude-side.js';
import type { ClaudeLaunch } from './claude-side.js';
import { InputQueue } from './input-queue.js';
import { watchChild } from './stderr.js';
import type { ChildExit } from './stderr.js';
import {
  beforeDeadline,
  NativeStopTimeout,
  stopDeadline,
  terminateChild,
  terminationReserveMs,
} from './shutdown.js';
import type {
  AccountReading,
  AgentStopOptions,
  SessionOptions,
} from './types.js';

export type UsageSource = 'main' | 'usage';

const limitWindow = z
  .object({
    utilization: z.number().nullable(),
    resets_at: z.string().nullable(),
  })
  .nullish();
const accountUsage = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: limitWindow,
      seven_day: limitWindow,
      limits: z.array(z.unknown()).nullish(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: z.number().nullable(),
          used_credits: z.number().nullable(),
          decimal_places: z.number().int().min(0).nullish(),
          currency: z
            .string()
            .regex(/^[A-Za-z]{3}$/)
            .nullish(),
        })
        .nullish()
        .catch(undefined),
    })
    .nullable(),
});
/** undefined for a report that doesn't parse; a window the report leaves null keeps its previous entry, time included. */
export function accountReading(
  report: unknown,
  previous: AccountReading,
): AccountReading | undefined {
  const account = accountUsage.safeParse(report);
  if (!account.success) return;
  const { rate_limits: limits, rate_limits_available: available } =
    account.data;
  if (!available)
    return {
      limits: [],
      funding: { kind: 'unavailable', observedAt: Date.now() },
      creditAccess: { state: 'unknown', observedAt: Date.now() },
    };
  // seeded failures omit native rows, so neither windows nor funding can acquire a new observation.
  if (!Array.isArray(limits?.limits)) return previous;
  const observedAt = Date.now() - 60_000;
  const windows = (
    [
      ['5H', limits?.five_hour],
      ['7D', limits?.seven_day],
    ] as const
  ).flatMap(([name, limit]) =>
    limit?.utilization == null
      ? previous.limits.filter((entry) => entry.window === name)
      : [
          {
            window: name,
            percent: limit.utilization,
            ...(limit.resets_at
              ? { resetsAt: Date.parse(limit.resets_at) / 1000 }
              : {}),
            observedAt,
          },
        ],
  );
  const extra = limits?.extra_usage;
  if (extra === undefined) return { ...previous, limits: windows };
  return {
    ...previous,
    limits: windows,
    funding: extra
      ? {
          kind: 'extra-usage',
          enabled: extra.is_enabled,
          used: extra.used_credits,
          limit: extra.monthly_limit,
          currency: extra.currency ?? null,
          decimalPlaces: extra.decimal_places ?? null,
          observedAt,
        }
      : { kind: 'unavailable', observedAt },
    // enabled spending does not establish funding or selected-model permission.
    creditAccess: {
      state: extra?.is_enabled === false ? 'unavailable' : 'unknown',
      observedAt,
    },
  };
}

interface Helper {
  input: InputQueue<SDKUserMessage>;
  abort: AbortController;
  query?: Query;
  child?: ChildExit;
  process?: ChildProcessWithoutNullStreams;
  reading?: Promise<void>;
  registered?: Promise<void>;
  ended: boolean;
  closing?: Promise<void>;
}

/** periodic account reads use a separate stdin queue so they cannot hold up conversation controls. */
export class ClaudeUsage {
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private requested = false;
  private closed = false;
  private helper?: Helper;
  private closing?: Promise<void>;

  constructor(
    private readonly options: Pick<
      SessionOptions,
      'cwd' | 'executable' | 'onUsageProcess'
    >,
    private readonly start: ClaudeLaunch,
    private readonly main: Query,
    private readonly onReport: (report: unknown, source: UsageSource) => void,
  ) {}

  refresh(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = true;
    if (!this.busy) void this.read('main');
  }

  close(options: AgentStopOptions = {}): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = false;
    return (this.closing ??= this.helper
      ? this.stop(this.helper, stopDeadline(options.deadline))
      : Promise.resolve());
  }

  private async read(source: UsageSource): Promise<void> {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      do {
        this.requested = false;
        try {
          const stream = source === 'main' ? this.main : await this.connect();
          if (this.closed) break;
          if (stream) {
            const report =
              await stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
                { skipBehaviors: true },
              );
            if (!this.closed) this.onReport(report, source);
          }
        } catch {
          // a failed optional read leaves the last valid snapshot visible until another refresh
        }
        source = 'main';
      } while (this.requested && !this.closed);
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.read('usage');
        }, 60_000);
        this.timer.unref();
      }
    }
  }

  private async connect(): Promise<Query | undefined> {
    if (this.helper?.ended) await this.stop(this.helper);
    if (this.closed) return;
    if (!this.helper) {
      const helper: Helper = {
        input: new InputQueue<SDKUserMessage>(),
        abort: new AbortController(),
        ended: false,
      };
      this.helper = helper;
      try {
        helper.query = promptlessQuery(
          this.start,
          this.options,
          helper.input,
          helper.abort,
          (child) => {
            helper.process = child;
            helper.child = watchChild(child);
            if (child.pid !== undefined) {
              helper.registered = (async () =>
                this.options.onUsageProcess?.(child.pid))();
              void helper.registered.catch(() => {});
            }
          },
        );
        const stream = helper.query;
        helper.reading = (async () => {
          try {
            for await (const message of stream) void message;
          } catch {
            // helper failure does not end the conversation; a later poll starts its replacement.
          } finally {
            helper.ended = true;
            void this.stop(helper).catch(() => {});
          }
        })();
        await Promise.all([stream.initializationResult(), helper.registered]);
      } catch (error) {
        await this.stop(helper);
        throw error;
      }
    }
    return !this.closed && !this.helper?.ended ? this.helper?.query : undefined;
  }

  private stop(helper: Helper, deadline = stopDeadline()): Promise<void> {
    return (helper.closing ??= (async () => {
      helper.ended = true;
      helper.input.close();
      helper.query?.close();
      helper.abort.abort();
      try {
        const stopped = Promise.all([helper.reading, helper.child?.closed]);
        try {
          await beforeDeadline(stopped, deadline - terminationReserveMs);
        } catch (error) {
          if (!(error instanceof NativeStopTimeout)) throw error;
          if (helper.process && helper.child)
            await terminateChild(helper.process, helper.child.closed, deadline);
          await beforeDeadline(stopped, deadline);
        }
        if (!helper.registered) return;
        try {
          await helper.registered;
        } catch {
          return;
        }
        await this.options.onUsageProcess?.(undefined);
      } finally {
        if (this.helper === helper) this.helper = undefined;
      }
    })());
  }
}
