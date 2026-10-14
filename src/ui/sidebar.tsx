import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { Subagent } from '../agents/types.js';
import { plain } from './links.js';
import { pentacle } from './pentacle.js';
import { accent, accentDim } from './theme.js';

const columns = 22;
const rows = 11;
/** the pentacle with the sidebar's border and padding. */
export const sidebarWidth = columns + 3;
/** turned a little, so the pentacle shows its depth at rest. */
const restAngle = 0.45;
const markers: Record<Subagent['status'], string> = {
  running: '●',
  completed: '✓',
  stopped: '■',
  failed: '✗',
};

/** depth first, each subagent under the one that started it; one whose parent isn't listed is a root. */
function lineage(
  subagents: readonly Subagent[],
): { subagent: Subagent; depth: number }[] {
  const ids = new Set(subagents.map(({ id }) => id));
  const lines: { subagent: Subagent; depth: number }[] = [];
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

/** the right sidebar: the agent's subagents, which it calls familiars, and the pentacle at its foot, turning while `spinning`. */
export function Sidebar({
  height,
  spinning,
  subagents,
}: {
  height: number;
  spinning: boolean;
  subagents: readonly Subagent[];
}) {
  const [angle, setAngle] = useState(restAngle);
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
  // the rows above the pentacle, less the heading; the newest rows show and a count stands in for the rest
  const room = height - rows - 1;
  const shown =
    familiars.length > room
      ? familiars.slice(familiars.length - Math.max(room - 1, 0))
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
            <Text
              key={subagent.id}
              wrap="truncate-end"
              dimColor={
                subagent.status === 'completed' || subagent.status === 'stopped'
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
