import { z } from 'zod';
import type { JsonRpc } from './json-rpc.js';
import type { Limit } from './types.js';

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
});
export type ObservedWindow = NonNullable<z.infer<typeof rateWindow>> & {
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

export async function readRateLimits(
  rpc: JsonRpc,
): Promise<z.infer<typeof rateLimits>> {
  const response = z.object({ rateLimits: z.unknown() }).parse(
    await rpc.request('account/rateLimits/read', {
      excludeResetCreditDetails: true,
    }),
  );
  return rateLimits.parse(response.rateLimits);
}

/** shortest window first; a window of unknown length has no name to show. */
export function windowLimits(
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
export async function probeLimits(
  rpc: JsonRpc,
  previous: readonly Limit[],
): Promise<Limit[]> {
  const { primary, secondary } = await readRateLimits(rpc);
  const observedAt = Date.now();
  const limits = windowLimits([
    primary && { ...primary, observedAt },
    secondary && { ...secondary, observedAt },
  ]);
  return [
    ...limits,
    ...previous.filter(
      ({ window }) => !limits.some((limit) => limit.window === window),
    ),
  ].sort((a, b) => windowMinutes(a.window) - windowMinutes(b.window));
}
