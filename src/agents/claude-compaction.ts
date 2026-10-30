import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnResult } from './types.js';

/** a manual compact has its own input/result identity even while the ordinary turn stays open. */
export class ClaudeCompaction {
  readonly finished = Promise.withResolvers<TurnResult>();
  result?: TurnResult;
  private replaced = false;
  private error?: string;

  constructor(
    readonly uuid: string,
    private started: boolean,
  ) {}

  lifecycle(uuid: string, state: string): boolean {
    if (uuid !== this.uuid) return false;
    if (state === 'started') this.started = true;
    else if (state !== 'queued' && state !== 'completed') {
      this.finish({
        status: 'failed',
        text: '',
        error: `Claude ${state} compaction`,
      });
      return true;
    }
    return false;
  }

  receive(message: SDKMessage, session: string): boolean {
    if (message.session_id !== session) return false;
    if (message.type === 'system' && this.started) {
      if (
        message.subtype === 'compact_boundary' &&
        message.compact_metadata.trigger === 'manual'
      )
        this.replaced = true;
      else if (
        message.subtype === 'status' &&
        message.compact_result === 'failed'
      )
        this.error = message.compact_error ?? 'Claude compaction failed';
    } else if (message.type === 'result') {
      const uuids = message.user_message_uuids ?? [message.user_message_uuid];
      if (!uuids.includes(this.uuid)) return false;
      const success =
        message.subtype === 'success' &&
        !message.is_error &&
        this.replaced &&
        !this.error;
      this.finish({
        status: success ? 'completed' : 'failed',
        text: '',
        ...(!success
          ? {
              error:
                this.error ??
                'Claude ended compaction without confirming history replacement',
            }
          : {}),
      });
      return true;
    }
    return false;
  }

  finish(result: TurnResult): void {
    this.result ??= result;
    this.finished.resolve(this.result);
  }
}
