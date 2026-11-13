import type { Snapshot } from '../core/snapshot.js';
import { accountRows } from './status-rows.js';
import type { Account, Status } from './status-rows.js';
import { wrapLines } from './wrap.js';

/** the text's width; the pentacle centers in it, sized by `rows`, its shorter side. */
export const columns = 32;
export const rows = 11;
/** the text with the sidebar's border and padding. */
export const sidebarWidth = columns + 3;

/** render once so sidebar placement and its height budget use identical rows. */
function usageLines(accounts: readonly Account[], now: number): string[] {
  return accounts.flatMap(({ id, reading }) =>
    accountRows(reading, now, true).flatMap((line, index) =>
      wrapLines(line, columns - 8, true).map(
        (part, continuation) =>
          `${(index || continuation ? '' : id.toUpperCase()).padEnd(8)}${part}`,
      ),
    ),
  );
}

/** every installed runtime's usage once any has reported, under the pentacle when it fits there and otherwise on the status line. */
export function usagePlacement(
  snapshot: Pick<Snapshot, 'agents' | 'accounts' | 'native' | 'conversation'>,
  sidebar: boolean,
  height: number,
  now = Date.now(),
): {
  sidebar: readonly string[];
  status: Pick<Status, 'account' | 'others'>;
} {
  const readings = snapshot.agents
    .filter(({ installed }) => installed)
    .map(({ id }) => ({ id, reading: snapshot.accounts[id] }));
  const accounts = readings.some(({ reading }) => reading) ? readings : [];
  const lines = usageLines(accounts, now);
  if (sidebar && height >= rows + 1 + lines.length)
    return { sidebar: lines, status: {} };
  const live = snapshot.native?.agent ?? snapshot.conversation?.agent;
  return {
    sidebar: [],
    status: {
      account: live ? snapshot.accounts[live] : undefined,
      others: accounts.filter(({ id }) => id !== live),
    },
  };
}
