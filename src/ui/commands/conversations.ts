import type { ListedConversation } from '../../persistence/store.js';

/**
 * a saved conversation's picker label. the time leads because a long title truncates, and is formatted by hand so it
 * reads the same in every locale.
 */
export function conversationLabel({
  modified,
  agent,
  title,
}: ListedConversation): string {
  const date = new Date(modified);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} · ${agent} · ${title}`;
}
