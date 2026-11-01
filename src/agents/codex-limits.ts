import { z } from 'zod';
import type { JsonRpc } from './json-rpc.js';
import type { AccountReading, Limit } from './types.js';

const rateWindow = z
  .object({
    usedPercent: z.number(),
    windowDurationMins: z.number().nullable(),
    resetsAt: z.number().nullable(),
  })
  .nullish();
export const rateLimits = z.object({
  limitId: z.string().nullish(),
  primary: rateWindow,
  secondary: rateWindow,
  credits: z
    .object({
      balance: z.string().nullish(),
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
    })
    .nullish()
    .catch(undefined),
  spendControlReached: z.boolean().nullish().catch(undefined),
  rateLimitReachedType: z.string().nullish().catch(undefined),
});
type ObservedWindow = NonNullable<z.infer<typeof rateWindow>> & {
  observedAt: number;
};

/** `5H` for 300 minutes, `7D` for 10080. */
function windowName(minutes: number): string {
  return minutes % 1440 === 0
    ? `${minutes / 1440}D`
    : `${Math.round(minutes / 60)}H`;
}

function windowMinutes(name: string): number {
  return Number.parseInt(name) * (name.endsWith('D') ? 1440 : 60);
}

export async function readRateLimits(rpc: JsonRpc): Promise<{
  rateLimits: z.infer<typeof rateLimits>;
  accountId?: string | null;
}> {
  const response = z
    .object({ rateLimits, accountId: z.string().nullish() })
    .parse(
      await rpc.request('account/rateLimits/read', {
        excludeResetCreditDetails: true,
      }),
    );
  return response;
}

function workspaceDenied(reason: string | null | undefined): boolean {
  return reason != null && reason !== 'rate_limit_reached';
}

/** rolling credit metadata cannot clear a spending denial; a complete account read can. */
function accountFunding(
  update: z.infer<typeof rateLimits>,
  complete: boolean,
): Pick<AccountReading, 'funding' | 'creditAccess'> {
  const observedAt = Date.now();
  const { credits, spendControlReached, rateLimitReachedType } = update;
  const funding = credits
    ? {
        kind: 'credits' as const,
        balance: credits.balance ?? null,
        available: credits.hasCredits,
        unlimited: credits.unlimited,
        observedAt,
      }
    : complete && credits === null
      ? { kind: 'unavailable' as const, observedAt }
      : undefined;
  const denied =
    spendControlReached === true ||
    workspaceDenied(rateLimitReachedType) ||
    (credits && !credits.unlimited && !credits.hasCredits);
  const state = denied
    ? 'unavailable'
    : complete &&
        credits &&
        spendControlReached === false &&
        (rateLimitReachedType === null ||
          rateLimitReachedType === 'rate_limit_reached')
      ? 'available'
      : complete
        ? 'unknown'
        : undefined;
  return {
    ...(funding ? { funding } : {}),
    ...(state ? { creditAccess: { state, observedAt } } : {}),
  };
}

/** shortest window first; a window of unknown length has no name to show. */
function windowLimits(
  windows: readonly (ObservedWindow | null | undefined)[],
): Limit[] {
  return windows
    .flatMap((window) =>
      window?.windowDurationMins == null
        ? []
        : [{ ...window, minutes: window.windowDurationMins }],
    )
    .sort((a, b) => a.minutes - b.minutes)
    .map(({ minutes, usedPercent, resetsAt, observedAt }) => ({
      window: windowName(minutes),
      percent: usedPercent,
      ...(resetsAt != null ? { resetsAt } : {}),
      observedAt,
    }));
}

/** a window the read leaves out keeps its `previous` entry, as a session's sparse updates do. */
export async function probeAccountUsage(
  rpc: JsonRpc,
  previous: AccountReading,
): Promise<AccountReading> {
  const { rateLimits: update, accountId } = await readRateLimits(rpc);
  const { primary, secondary, limitId } = update;
  const identity = accountId
    ? `${accountId}:${limitId ?? 'codex'}`
    : previous.identity;
  if (identity !== previous.identity) previous = { limits: [] };
  const observedAt = Date.now();
  const limits = windowLimits([
    primary && { ...primary, observedAt },
    secondary && { ...secondary, observedAt },
  ]);
  return {
    ...previous,
    ...(identity ? { identity } : {}),
    ...accountFunding(update, true),
    limits: [
      ...limits,
      ...previous.limits.filter(
        ({ window }) => !limits.some((limit) => limit.window === window),
      ),
    ].sort((a, b) => windowMinutes(a.window) - windowMinutes(b.window)),
  };
}

/** merges native account slots without borrowing observations from another account or quota. */
export class CodexAccount {
  private limitId?: string;
  private windows: { primary?: ObservedWindow; secondary?: ObservedWindow } =
    {};
  private reading: AccountReading = { limits: [] };

  update(
    update: z.infer<typeof rateLimits>,
    complete = false,
    accountId?: string | null,
  ): AccountReading | undefined {
    const identity = accountId
      ? `${accountId}:${update.limitId ?? 'codex'}`
      : undefined;
    if (identity && identity !== this.reading.identity) {
      this.windows = {};
      this.limitId = undefined;
      this.reading = { limits: [], identity };
    }
    if (update.limitId) {
      if (this.limitId && update.limitId !== this.limitId) {
        if (workspaceDenied(update.rateLimitReachedType)) {
          this.reading = {
            ...this.reading,
            creditAccess: { state: 'unavailable', observedAt: Date.now() },
          };
          return this.reading;
        }
        return;
      }
      this.limitId = update.limitId;
    }
    const observedAt = Date.now();
    if (update.primary)
      this.windows.primary = { ...update.primary, observedAt };
    if (update.secondary)
      this.windows.secondary = { ...update.secondary, observedAt };
    this.reading = {
      ...this.reading,
      ...accountFunding(update, complete),
      limits: windowLimits([this.windows.primary, this.windows.secondary]),
    };
    return this.reading;
  }
}
