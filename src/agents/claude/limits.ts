import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import type { ExhaustedLimit } from '../types.js';

/** what each `rateLimitType` blocks; Claude Code labels `seven_day_overage_included` the Fable limit. */
const windows: Partial<Record<string, { window: string; model?: string }>> = {
  five_hour: { window: '5H' },
  seven_day: { window: '7D' },
  seven_day_opus: { window: '7D', model: 'Opus' },
  seven_day_sonnet: { window: '7D', model: 'Sonnet' },
  seven_day_overage_included: { window: '7D', model: 'Fable' },
};

/** Claude Code's latest rate-limit report and the turn it arrived in, which it sends apart from the result it explains. */
export class RateLimit<Turn> {
  private latest?: { info: SDKRateLimitInfo; turn?: Turn };

  report(info: SDKRateLimitInfo, turn: Turn | undefined): void {
    this.latest = { info, turn };
  }

  clear(): void {
    this.latest = undefined;
  }

  /** the limit that rejects work on `model` in `turn`, if the report does. one without a reset time or window speaks only for the turn it arrived in. */
  rejection(
    turn: Turn,
    model: string,
    now = Date.now(),
  ): ExhaustedLimit | undefined {
    const { info, turn: arrived } = this.latest ?? {};

    if (info?.status !== 'rejected') return;

    if (
      info.isUsingOverage ||
      info.overageInUse ||
      info.overageStatus?.startsWith('allowed')
    )
      return;

    if ((info.resetsAt ?? Infinity) * 1000 <= now) return;

    if (arrived !== turn && !(info.resetsAt && info.rateLimitType)) return;

    const blocked = windows[info.rateLimitType ?? ''];

    if (
      blocked?.model &&
      !model.split('-').includes(blocked.model.toLowerCase())
    )
      return;

    return {
      ...blocked,
      ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}),
      ...(info.overageStatus === 'rejected' && info.overageDisabledReason
        ? { credits: info.overageDisabledReason.replaceAll('_', ' ') }
        : {}),
    };
  }
}
