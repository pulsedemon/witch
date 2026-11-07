import type { Query, Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { compactionThreshold } from '../core/compaction-policy.js';
import type { Usage } from './types.js';

export interface ClaudeCompactionControl extends Pick<
  Query,
  'getContextUsage' | 'applyFlagSettings'
> {
  getSettings(): Promise<unknown>;
}

const context = z.object({
  maxTokens: z.number().positive(),
  autoCompactThreshold: z.number().positive(),
  isAutoCompactEnabled: z.boolean(),
});
const settings = z.object({
  sources: z.array(
    z.object({
      source: z.string(),
      settings: z.object({ env: z.record(z.string(), z.string()).optional() }),
    }),
  ),
});

export class ClaudeContext {
  private context?: z.infer<typeof context>;
  private applied?: string;
  private restore?: () => Promise<string | undefined>;

  constructor(
    private readonly getQuery: () => Query | ClaudeCompactionControl,
  ) {}

  /** the SDK implements getSettings but omits it from Query. */
  private get query(): ClaudeCompactionControl {
    return this.getQuery() as ClaudeCompactionControl;
  }

  readonly bind = (read: () => Promise<string | undefined>): (() => void) => {
    this.restore = read;
    return () => {
      if (this.restore === read) this.restore = undefined;
    };
  };

  readonly hooks: Options['hooks'] = {
    SessionStart: [
      {
        matcher: 'compact',
        hooks: [
          async () => {
            const text = await this.restore?.();
            return text
              ? {
                  hookSpecificOutput: {
                    hookEventName: 'SessionStart',
                    additionalContext: text,
                  },
                }
              : {};
          },
        ],
      },
    ],
  };

  async read(
    current: () => string | undefined,
    publish: (usage: Usage) => void,
  ): Promise<number | undefined> {
    const model = current();
    try {
      const value = await this.query.getContextUsage({ detail: 'summary' });
      if (model === undefined || current() !== model) return;
      this.observe(value);
      const percentage = z.number().safeParse(value.percentage);
      const capacity = z.number().safeParse(value.maxTokens);
      const usage = {
        ...(percentage.success ? { context: percentage.data } : {}),
        ...(capacity.success ? { contextWindow: capacity.data } : {}),
      };
      if (Object.keys(usage).length) publish(usage);
      return usage.context;
    } catch {
      return undefined;
    }
  }

  observe(value: unknown): void {
    this.context = context.safeParse(value).data;
  }

  invalidate(): void {
    this.context = undefined;
  }

  async configure(): Promise<void> {
    if (!this.context)
      this.observe(await this.query.getContextUsage({ detail: 'summary' }));
    const sample = this.context;
    if (!sample?.isAutoCompactEnabled) return;
    const { tokens } = compactionThreshold(sample.maxTokens);
    // the native percentage uses capacity before its 13k summary reserve, not maxTokens.
    const capacity = sample.autoCompactThreshold + 13_000;
    // native rounding must keep the target token rather than lose one to floating point.
    const percentage = String(Math.min(100, ((tokens + 0.5) * 100) / capacity));
    if (percentage === this.applied) return;
    const flags = settings
      .parse(await this.query.getSettings())
      .sources.find((entry) => entry.source === 'flagSettings');
    await this.query.applyFlagSettings({
      env: {
        ...flags?.settings.env,
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: percentage,
      },
    });
    this.applied = percentage;
  }
}
