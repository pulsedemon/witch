import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { basename } from 'node:path';
import type { BackgroundCommand, Limit } from '../agents/types.js';
import type { TimedSubagent } from '../core/snapshot.js';
import { familiarIdentity } from '../core/familiars.js';
import type { CoordinationSnapshot } from '../core/coordination-state.js';
import type { PentacleActivity } from '../core/pentacle-activity.js';
import { elapsed } from './activity.js';
import { hyperlink, oneLine } from './links.js';
import { peerStatus, peerTitle } from './peers.js';
import { pentacle } from './pentacle.js';
import { accent, accentDim, piped } from './theme.js';
import { windowText } from './status-line.js';
import { wrapLines } from './wrap.js';

/** the text's width; the pentacle centers in it, sized by `rows`, its shorter side. */
const columns = 32;
const rows = 11;
/** the text with the sidebar's border and padding. */
export const sidebarWidth = columns + 3;
/** turned a little, so the pentacle shows its depth at rest. */
const restAngle = 0.45;
/** retain the last complete entries and reserve a count row when any are hidden. */
function fit<T>(
  entries: readonly T[],
  cost: (entry: T) => number,
  room: number,
): { shown: readonly T[]; hidden: number } {
  let used = entries.reduce((sum, entry) => sum + cost(entry), 0);
  let hidden = 0;
  if (used > room) {
    while (hidden < entries.length && used > room - 1)
      used -= cost(entries[hidden++]!);
  }
  return { shown: entries.slice(hidden), hidden };
}

/** depth first, each subagent under the one that started it; one whose parent isn't listed is a root. */
function lineage(
  subagents: readonly TimedSubagent[],
): { subagent: TimedSubagent; depth: number }[] {
  const ids = new Set(subagents.map(({ id }) => id));
  const lines: { subagent: TimedSubagent; depth: number }[] = [];
  const visit = (parent: string | undefined, depth: number) => {
    for (const subagent of subagents) {
      const listed =
        subagent.parent !== undefined && ids.has(subagent.parent)
          ? subagent.parent
          : undefined;
      if (listed !== parent) continue;
      lines.push({ subagent, depth });
      visit(subagent.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return lines;
}

export interface Account {
  id: string;
  /** `undefined` until a reading arrives. */
  limits?: readonly Limit[];
}

/** a heading, then a row per window or one `?` row per runtime. */
function usageRows(accounts: readonly Account[]): number {
  return (
    1 +
    accounts.reduce(
      (sum, { limits }) => sum + Math.max(1, limits?.length ?? 0),
      0,
    )
  );
}

/** whether every runtime's usage fits under the pentacle; otherwise the status line carries it. */
export function fitsUsage(
  height: number,
  accounts: readonly Account[],
): boolean {
  return height >= rows + usageRows(accounts);
}

/** peer sessions precede local work without taking its last heading and count rows or the pentacle's space. */
export function Sidebar({
  height,
  activity,
  brews,
  subagents,
  peers = [],
  accounts = [],
}: {
  height: number;
  activity: PentacleActivity;
  brews: readonly BackgroundCommand[];
  subagents: readonly TimedSubagent[];
  peers?: CoordinationSnapshot['peers'];
  /** every runtime's usage, shown under the pentacle; empty when it doesn't fit. */
  accounts?: readonly Account[];
}) {
  const spinning = useSyncExternalStore(
    activity.subscribe,
    () => activity.active,
  );
  const [angle, setAngle] = useState(restAngle);
  const [now, setNow] = useState(Date.now);
  const familiars = lineage(
    subagents.filter(({ status }) => status === 'running'),
  ).map(({ subagent, depth }) => {
    const indent = '  '.repeat(Math.min(depth + 1, 2));
    const identity = oneLine(familiarIdentity(subagent));
    return {
      subagent,
      depth,
      identity: identity
        ? wrapLines(identity, columns - indent.length, true).map(
            (line) => indent + line,
          )
        : [],
    };
  });
  const running = familiars.length > 0;
  const usage = accounts.length > 0;
  // familiars count seconds; usage alone only needs its ages and resets to keep time
  useEffect(() => {
    if (!running && !usage) return;
    const timer = setInterval(() => setNow(Date.now()), running ? 1000 : 5000);
    return () => clearInterval(timer);
  }, [running, usage]);
  useEffect(() => {
    // wherever work stopped it, the pentacle returns to its rest angle, since edge on it reads as a line
    if (!spinning) {
      setAngle(restAngle);
      return;
    }
    const timer = setInterval(() => setAngle((value) => value + 0.12), 80);
    return () => clearInterval(timer);
  }, [spinning]);
  const lines = useMemo(() => pentacle(angle, columns, rows), [angle]);
  const below = rows + (usage ? usageRows(accounts) : 0);
  // brews take the rows above the pentacle first, less a running familiar's heading and count
  const peerRoom = Math.min(
    8,
    Math.max(0, height - below) - (brews.length ? 2 : 0) - (running ? 2 : 0),
  );
  const listedPeers = fit(peers, () => 2, peerRoom - 1);
  const peerRows =
    peers.length && peerRoom >= 2
      ? 1 + (listedPeers.hidden ? 1 : 0) + listedPeers.shown.length * 2
      : 0;
  const above = height - below - peerRows;
  const brewRoom = above - (running ? 2 : 0) - 1;
  const brewing = brews.length > 0 && brewRoom > 0;
  const listedBrews = fit(brews, () => 1, brewRoom);
  const brewRows = brewing
    ? 1 + (listedBrews.hidden ? 1 : 0) + listedBrews.shown.length
    : 0;
  // the last familiars in tree order show and a count stands in for the rest
  const room = above - brewRows - 1;
  const { shown, hidden } = fit(
    familiars,
    ({ identity }) => 3 + identity.length,
    room,
  );
  return (
    <Box
      flexDirection="column"
      justifyContent="flex-end"
      width={sidebarWidth}
      height={height}
      overflow="hidden"
      borderStyle="bold"
      borderColor={accentDim}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingX={1}
    >
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {peerRows > 0 && (
          <>
            <Text color={accent}>SESSIONS</Text>
            {listedPeers.hidden > 0 && (
              <Text dimColor>+{listedPeers.hidden} MORE</Text>
            )}
            {listedPeers.shown.map((peer) => (
              <Box key={peer.presence.id} flexDirection="column">
                <Text wrap="truncate-end">{peerTitle(peer)}</Text>
                <Text wrap="truncate-end" dimColor>
                  {oneLine(peer.presence.agent)} | {peerStatus(peer)} |{' '}
                  {hyperlink(
                    oneLine(basename(peer.presence.cwd)),
                    peer.presence.cwd,
                    peer.presence.cwd,
                  )}
                </Text>
              </Box>
            ))}
          </>
        )}
        {brewing && (
          <>
            <Text color={accent}>BREWS</Text>
            {listedBrews.hidden > 0 && (
              <Text dimColor>+{listedBrews.hidden} MORE</Text>
            )}
            {listedBrews.shown.map((brew) => (
              <Text key={brew.id} wrap="truncate-end">
                <Text color={accent}>●</Text>{' '}
                {oneLine(brew.description).toUpperCase()}
              </Text>
            ))}
          </>
        )}
        {running && room > 0 && (
          <>
            <Text color={accent}>FAMILIARS</Text>
            {hidden > 0 && <Text dimColor>+{hidden} MORE</Text>}
            {shown.map(({ subagent, depth, identity }) => (
              <Box key={subagent.id} flexDirection="column">
                <Text wrap="truncate-end">
                  {'  '.repeat(depth)}
                  <Text color={accent}>●</Text>{' '}
                  {oneLine(subagent.name).toUpperCase()}
                  {subagent.kind && (
                    <Text dimColor> {oneLine(subagent.kind)}</Text>
                  )}
                </Text>
                {identity.map((line, index) => (
                  <Text key={index} dimColor>
                    {line}
                  </Text>
                ))}
                <Text wrap="truncate-end" dimColor>
                  {'  '.repeat(depth + 1)}
                  {piped([
                    // one that started since the last tick shows 0S, not -1S
                    elapsed(Math.max(0, now - subagent.startedAt)),
                    `${subagent.tools ?? 0} TOOL${subagent.tools === 1 ? '' : 'S'}`,
                  ])}
                </Text>
                <Text wrap="truncate-end" dimColor>
                  {'  '.repeat(depth + 1)}
                  {oneLine(subagent.activity ?? '')}
                </Text>
              </Box>
            ))}
          </>
        )}
      </Box>
      {lines.map((runs, row) => (
        <Text key={row}>
          {runs.map((run, index) => (
            <Text key={index} color={run.near ? accent : accentDim}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
      {usage && <Text color={accent}>USAGE</Text>}
      {accounts.flatMap(({ id, limits }) =>
        (limits?.length ? limits : [undefined]).map((limit, index) => (
          <Text key={`${id}:${index}`} wrap="truncate-end">
            {(index ? '' : id.toUpperCase()).padEnd(8)}
            {limit ? windowText(limit, now, true) : '?'}
          </Text>
        )),
      )}
    </Box>
  );
}
