import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { basename } from 'node:path';
import type { BackgroundCommand } from '../../agents/types.js';
import type { TimedSubagent } from '../../core/snapshot.js';
import { familiarIdentity } from '../../core/familiars.js';
import type { CoordinationSnapshot } from '../../core/coordination/coordination-state.js';
import type { PentacleActivity } from '../../core/pentacle-activity.js';
import { elapsed } from './elapsed.js';
import { hyperlink, oneLine } from '../links.js';
import { peerStatus, peerTitle } from '../commands/peers.js';
import { pentacle } from './pentacle.js';
import { columns, rows, sidebarWidth } from './sidebar-layout.js';
import { accent, accentDim, piped } from '../theme.js';
import { useTick } from '../useTick.js';
import { wrapLines } from '../wrap.js';

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

/** peer sessions precede local work without taking its last heading and count rows or the space of the pentacle and usage block. */
export function Sidebar({
  height,
  activity,
  brews,
  subagents,
  peers = [],
  usage: usageText = [],
}: {
  height: number;
  activity: PentacleActivity;
  brews: readonly BackgroundCommand[];
  subagents: readonly TimedSubagent[];
  peers?: CoordinationSnapshot['peers'];
  /** every runtime's usage, shown under the pentacle; empty when it doesn't fit. */
  usage?: readonly string[];
}) {
  const spinning = useSyncExternalStore(
    activity.subscribe,
    () => activity.active,
  );

  const tick = useTick(1, spinning);
  const [turn, setTurn] = useState({ spinning, from: tick });

  if (turn.spinning !== spinning) setTurn({ spinning, from: tick });

  // wherever work stopped it, the pentacle returns to its rest angle, since edge on it reads as a line
  const angle =
    spinning && turn.spinning
      ? restAngle + (tick - turn.from) * 0.075
      : restAngle;

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
  const usage = usageText.length > 0;

  useEffect(() => {
    if (!running) return;

    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [running]);

  const lines = useMemo(() => pentacle(angle, columns, rows), [angle]);
  const below = rows + (usage ? 1 + usageText.length : 0);

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
                <Text color={accent}>●</Text> {oneLine(brew.description)}
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
                  <Text color={accent}>●</Text> {oneLine(subagent.name)}
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
      {usageText.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
}
