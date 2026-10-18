import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { BackgroundCommand } from '../agents/types.js';
import type { TimedSubagent } from '../core/coordinator.js';
import { elapsed } from './activity.js';
import { oneLine } from './links.js';
import { pentacle } from './pentacle.js';
import { accent, accentDim, piped } from './theme.js';

/** the text's width; the pentacle centers in it, sized by `rows`, its shorter side. */
const columns = 32;
const rows = 11;
/** the text with the sidebar's border and padding. */
export const sidebarWidth = columns + 3;
/** turned a little, so the pentacle shows its depth at rest. */
const restAngle = 0.45;
/** a familiar's name, its time and tool count, and its latest tool call. */
const familiarRows = 3;

/** the last entries of `each` rows that fit in `room` rows, with a row for a count of the rest when some don't. */
function fit<T>(
  entries: readonly T[],
  each: number,
  room: number,
): { shown: readonly T[]; hidden: number } {
  const shown =
    entries.length * each > room
      ? entries.slice(entries.length - Math.floor(Math.max(room - 1, 0) / each))
      : entries;
  return { shown, hidden: entries.length - shown.length };
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

/** the right sidebar: the agent's running background commands and subagents, which Witch calls brews and familiars, and the pentacle at its foot, turning while `spinning`. */
export function Sidebar({
  height,
  spinning,
  brews,
  subagents,
}: {
  height: number;
  spinning: boolean;
  brews: readonly BackgroundCommand[];
  subagents: readonly TimedSubagent[];
}) {
  const [angle, setAngle] = useState(restAngle);
  const [now, setNow] = useState(Date.now);
  const familiars = lineage(
    subagents.filter(({ status }) => status === 'running'),
  );
  const running = familiars.length > 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
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
  // brews take the rows above the pentacle first, less a running familiar's heading and count
  const above = height - rows;
  const brewRoom = above - (running ? 2 : 0) - 1;
  const brewing = brews.length > 0 && brewRoom > 0;
  const listedBrews = fit(brews, 1, brewRoom);
  const brewRows = brewing
    ? 1 + (listedBrews.hidden ? 1 : 0) + listedBrews.shown.length
    : 0;
  // the last familiars in tree order show and a count stands in for the rest
  const room = above - brewRows - 1;
  const { shown, hidden } = fit(familiars, familiarRows, room);
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
            {shown.map(({ subagent, depth }) => (
              <Box key={subagent.id} flexDirection="column">
                <Text wrap="truncate-end">
                  {'  '.repeat(depth)}
                  <Text color={accent}>●</Text>{' '}
                  {oneLine(subagent.name).toUpperCase()}
                  {subagent.kind && (
                    <Text dimColor> {oneLine(subagent.kind)}</Text>
                  )}
                </Text>
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
    </Box>
  );
}
