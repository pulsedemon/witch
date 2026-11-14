import type { ConversationRecord } from './state.js';
import type { Skill } from '../agents/types.js';
import { shellCommand, skillCall } from './prompts.js';

/**
 * a listed spell or native command, or a `!` command, takes a turn alone: a spell runs from a turn's prompt, and a
 * `!` command's reply is a turn of its own. any other `/` text, such as a path, is a prompt, but until a session lists
 * its skills any `/` text could be a spell.
 */
function alone(prompt: string, skills?: readonly Skill[]): boolean {
  return (
    (skills
      ? skillCall(prompt, skills) !== undefined
      : prompt.trimStart().startsWith('/')) ||
    shellCommand(prompt) !== undefined
  );
}

/** the queue's next turn: a prompt that goes alone, or the prompts before the next one, a line each. */
export function nextTurn(
  queue: readonly string[],
  skills?: readonly Skill[],
): string[] {
  const command = queue.findIndex((prompt) => alone(prompt, skills));

  return queue.slice(
    0,
    command === 0 ? 1 : command < 0 ? queue.length : command,
  );
}

/** a prompt sent now keeps its place behind a queued prompt or `!` command; a spell the turn refused holds nothing. */
export function waitsBehind(
  queue: readonly string[],
  skills: readonly Skill[],
): boolean {
  return queue.some((queued) => !skillCall(queued, skills));
}

/** what is queued behind a turn's prompt and can join it: everything before the first `!` command. */
export function joining(queue: readonly string[]): string[] {
  const command = queue.findIndex(
    (prompt) => shellCommand(prompt) !== undefined,
  );

  return queue.slice(0, command < 0 ? queue.length : command);
}

/**
 * steers the prompts in order, and gives `back` those still owed to the queue: a refused spell, which holds nothing,
 * and a refused prompt with the ones after it. a steer that throws gives back its prompt and the rest.
 */
export async function steerInOrder(
  prompts: readonly string[],
  skills: readonly Skill[],
  steer: (prompt: string) => Promise<boolean>,
  back: (prompts: string[]) => void,
): Promise<void> {
  const refused: string[] = [];
  let next = 0;

  try {
    for (; next < prompts.length; next++) {
      const prompt = prompts[next]!;

      if (await steer(prompt)) continue;

      if (skillCall(prompt, skills)) refused.push(prompt);
      else break;
    }
  } finally {
    const owed = [...refused, ...prompts.slice(next)];

    if (owed.length) back(owed);
  }
}

/** a sent prompt, kept by identity so equal texts stay distinct. */
export interface Pending {
  prompt: string;
}

export function without(list: readonly Pending[], removed: readonly Pending[]) {
  return list.filter((entry) => !removed.includes(entry));
}

/** copies the prompts sent but not yet shown into the record, in the order they were sent; true when they changed. */
export function recordQueue(
  record: ConversationRecord | undefined,
  taken: readonly Pending[],
  queued: readonly string[],
  arriving: readonly Pending[],
): boolean {
  if (!record) return false;

  const queue = [
    ...taken.map(({ prompt }) => prompt),
    ...queued,
    ...arriving.map(({ prompt }) => prompt),
  ];

  const saved = record.queue ?? [];

  if (
    queue.length === saved.length &&
    queue.every((prompt, i) => prompt === saved[i])
  )
    return false;

  if (queue.length) record.queue = queue;
  else delete record.queue;

  return true;
}
