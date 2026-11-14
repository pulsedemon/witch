import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';

/** weekly windows that block only one model family; Claude Code labels `seven_day_overage_included` the Fable limit. */
const families: Partial<Record<string, string>> = {
  seven_day_opus: 'opus',
  seven_day_sonnet: 'sonnet',
  seven_day_overage_included: 'fable',
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

  /** whether the report rejects work on `model` in `turn`. one without a reset time or window speaks only for the turn it arrived in. */
  rejects(turn: Turn, model: string, now = Date.now()): boolean {
    const { info, turn: arrived } = this.latest ?? {};

    if (info?.status !== 'rejected') return false;

    if (
      info.isUsingOverage ||
      info.overageInUse ||
      info.overageStatus?.startsWith('allowed')
    )
      return false;

    if ((info.resetsAt ?? Infinity) * 1000 <= now) return false;

    if (arrived !== turn && !(info.resetsAt && info.rateLimitType))
      return false;

    const family = families[info.rateLimitType ?? ''];

    return !family || model.split('-').includes(family);
  }
}
