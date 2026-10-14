import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { Subagent } from '../agents/types.js';
import type { TimedSubagent } from '../core/coordinator.js';
import { elapsed } from './activity.js';
import { plain } from './links.js';
import { pentacle } from './pentacle.js';
import { accent, accentDim, piped } from './theme.js';

const columns = 22;
const rows = 11;
/** the pentacle with the sidebar's border and padding. */
export const sidebarWidth = columns + 3;
/** turned a little, so the pentacle shows its depth at rest. */
const restAngle = 0.45;
/** a familiar's name, its time and tool count, and its latest tool call. */
const familiarRows = 3;
const markers: Record<Subagent['status'], string> = {
  running: '●',
  completed: '✓',
  stopped: '■',
  failed: '✗',
};

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

/** the right sidebar: the agent's subagents, which Witch calls familiars, and the pentacle at its foot, turning while `spinning`. */
export function Sidebar({
  height,
  spinning,
  subagents,
}: {
  height: number;
  spinning: boolean;
  subagents: readonly TimedSubagent[];
}) {
  const [angle, setAngle] = useState(restAngle);
  const [now, setNow] = useState(Date.now);
  const running = subagents.some(({ status }) => status === 'running');
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
  const familiars = lineage(subagents);
  // the rows above the pentacle, less the heading; the last familiars in tree order show and a count stands in for the rest
  const room = height - rows - 1;
  const shown =
    familiars.length * familiarRows > room
      ? familiars.slice(
          familiars.length - Math.floor(Math.max(room - 1, 0) / familiarRows),
        )
      : familiars;
  const hidden = familiars.length - shown.length;
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
      {familiars.length > 0 && room > 0 && (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Text color={accent}>FAMILIARS</Text>
          {hidden > 0 && <Text dimColor>+{hidden} MORE</Text>}
          {shown.map(({ subagent, depth }) => (
            <Box key={subagent.id} flexDirection="column">
              <Text
                wrap="truncate-end"
                dimColor={
                  subagent.status === 'completed' ||
                  subagent.status === 'stopped'
                }
              >
                {'  '.repeat(depth)}
                <Text
                  color={
                    subagent.status === 'running'
                      ? accent
                      : subagent.status === 'failed'
                        ? 'red'
                        : undefined
                  }
                >
                  {markers[subagent.status]}
                </Text>{' '}
                {plain(subagent.name).replace(/\s+/g, ' ').toUpperCase()}
                {subagent.kind && <Text dimColor> {plain(subagent.kind)}</Text>}
              </Text>
              <Text wrap="truncate-end" dimColor>
                {'  '.repeat(depth + 1)}
                {piped([
                  // one that started since the last tick shows 0S, not -1S
                  elapsed(
                    Math.max(0, (subagent.endedAt ?? now) - subagent.startedAt),
                  ),
                  `${subagent.tools ?? 0} TOOL${subagent.tools === 1 ? '' : 'S'}`,
                ])}
              </Text>
              <Text wrap="truncate-end" dimColor>
                {'  '.repeat(depth + 1)}
                {plain(subagent.activity ?? '').replace(/\s+/g, ' ')}
              </Text>
            </Box>
          ))}
        </Box>
      )}
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
