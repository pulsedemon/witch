import { z } from 'zod';
import type {
  Query,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { errorMessage } from '../../errors.js';
import type { InputQueue } from '../input-queue.js';
import { TurnText } from '../turn-text.js';
import type { TurnResult } from '../types.js';

export interface Turn {
  started: ReturnType<typeof Promise.withResolvers<boolean>>;
  finished: ReturnType<typeof Promise.withResolvers<TurnResult>>;
  result?: TurnResult;
  interrupted: boolean;
  messages: TurnText;
  /** pending until acknowledged, so a result from Claude Code's own run can't settle the turn; generated context never returns unread. */
  inputs: Map<
    string,
    { prompt?: string; pending: boolean; contextOnly?: true }
  >;
  inputError?: string;
  commandRecords: Map<string, { records: string[]; writeAttempted: boolean }>;
  initialInput?: string;
  /** keep native idle from settling the turn before the steered command's reply is queued. */
  held: boolean;
  /** native idle can precede delivery of input this turn already accepted. */
  idle: boolean;
  answer?: string;
  compaction?: true;
  exhausting?: boolean;
}

export function createTurn(): Turn {
  return {
    started: Promise.withResolvers<boolean>(),
    finished: Promise.withResolvers<TurnResult>(),
    interrupted: false,
    messages: new TurnText(),
    inputs: new Map(),
    commandRecords: new Map(),
    held: false,
    idle: false,
  };
}

export function claudeResult(
  message: SDKResultMessage,
  answer: boolean,
  text: string,
): TurnResult {
  const success = message.subtype === 'success' && !message.is_error;

  return {
    status: success ? 'completed' : 'failed',
    text:
      message.subtype === 'success'
        ? answer
          ? (JSON.stringify(message.structured_output) ?? '')
          : message.result
        : text,
    ...(!success
      ? {
          error:
            message.subtype === 'success'
              ? message.result
              : message.errors.join('\n'),
        }
      : {}),
  };
}

/** an interrupt receipt proves which waiting prompts can move without replaying consumed input. */
export async function recoverInput(
  turn: Turn,
  input: InputQueue<SDKUserMessage>,
  query: Query,
): Promise<TurnResult> {
  try {
    await input.flush();

    const receipt = await query.interrupt();
    const unread = receipt?.still_queued;
    const inputUnread = unread?.includes(turn.initialInput!) ?? false;

    if (!inputUnread && !turn.result) throw new Error(unknownInput);

    return {
      ...(inputUnread
        ? {
            status: 'failed' as const,
            text: '',
            exhausted: true as const,
            inputUnread: true as const,
          }
        : idleResult(turn, false)),
      unread: (unread ?? []).flatMap(
        (uuid) => turn.inputs.get(uuid)?.prompt ?? [],
      ),
      unreadContext: (unread ?? []).flatMap(
        (uuid) => turn.commandRecords.get(uuid)?.records ?? [],
      ),
    };
  } catch (error) {
    return {
      status: 'failed',
      text: turn.messages.text,
      error: errorMessage(error),
    };
  }
}

export function recordResult(
  turn: Turn,
  result: TurnResult,
  uuids: (string | undefined)[],
  messageLifecycle: boolean,
): void {
  if (messageLifecycle)
    for (const uuid of uuids) {
      const input = uuid === undefined ? undefined : turn.inputs.get(uuid);

      if (!input) continue;

      input.pending = false;

      if (result.status !== 'completed' && !turn.interrupted)
        turn.inputError ??= result.error;
    }

  turn.result = result;
}

export function idleResult(turn: Turn, rejected: boolean): TurnResult {
  return {
    ...(turn.inputError !== undefined
      ? {
          status: 'failed',
          text: turn.result?.text ?? '',
          error: turn.inputError,
        }
      : turn.result!),
    ...(turn.result?.status === 'failed' && !turn.interrupted && rejected
      ? { exhausted: true }
      : {}),
  };
}

export const commandLifecycle = z.object({
  type: z.literal('command_lifecycle'),
  session_id: z.string(),
  command_uuid: z.string(),
  state: z.enum([
    'queued',
    'started',
    'completed',
    'cancelled',
    'discarded',
    'refused',
  ]),
});

export const unknownInput =
  'Claude ran out of usage; queued input consumption could not be verified. Resume explicitly.';

export function pendingInput(turn: Turn | undefined): boolean {
  return (
    !!turn?.initialInput && turn.inputs.get(turn.initialInput)?.pending === true
  );
}

export function uncertainInput(turn: Turn | undefined): boolean {
  return (
    pendingInput(turn) &&
    turn!.commandRecords.get(turn!.initialInput!)?.writeAttempted !== false
  );
}
