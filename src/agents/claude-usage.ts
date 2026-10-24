import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKUserMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from './input-queue.js';
import { watchChild } from './stderr.js';
import type { ChildExit } from './stderr.js';
import type { SessionOptions } from './types.js';

export type ClaudeLaunch = (
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;
export type UsageSource = 'main' | 'usage';

interface Helper {
  input: InputQueue<SDKUserMessage>;
  abort: AbortController;
  query?: Query;
  child?: ChildExit;
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

  close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.requested = false;
    return (this.closing ??= this.helper
      ? this.stop(this.helper)
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
          // a failed optional read leaves the last valid snapshot visible until another refresh.
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
        helper.query = query({
          prompt: helper.input,
          options: {
            cwd: this.options.cwd,
            pathToClaudeCodeExecutable: this.options.executable,
            abortController: helper.abort,
            settingSources: ['user', 'project', 'local'],
            persistSession: false,
            settings: { disableAllHooks: true },
            strictMcpConfig: true,
            mcpServers: {},
            spawnClaudeCodeProcess: (options) => {
              const child = this.start(options);
              helper.child = watchChild(child);
              if (child.pid !== undefined) {
                helper.registered = (async () =>
                  this.options.onUsageProcess?.(child.pid))();
                void helper.registered.catch(() => {});
              }
              return child;
            },
          },
        });
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
        await stream.initializationResult();
        await helper.registered;
      } catch (error) {
        await this.stop(helper);
        throw error;
      }
    }
    return !this.closed && !this.helper?.ended ? this.helper?.query : undefined;
  }

  private stop(helper: Helper): Promise<void> {
    return (helper.closing ??= (async () => {
      helper.ended = true;
      helper.input.close();
      helper.query?.close();
      helper.abort.abort();
      try {
        await helper.reading;
        await helper.child?.closed;
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
