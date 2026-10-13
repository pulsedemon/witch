import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { pentacle } from './pentacle.js';
import { accent, accentDim } from './theme.js';

const columns = 22;
const rows = 11;
/** the pentacle with the sidebar's border and padding. */
export const sidebarWidth = columns + 3;
/** turned a little, so the pentacle shows its depth at rest. */
const restAngle = 0.45;

/** the right sidebar, with the pentacle at its foot, turning while `spinning`. */
export function Sidebar({
  height,
  spinning,
}: {
  height: number;
  spinning: boolean;
}) {
  const [angle, setAngle] = useState(restAngle);
  useEffect(() => {
    // wherever work stopped it, the pentacle rests face on, since edge on it reads as a line
    if (!spinning) {
      setAngle(restAngle);
      return;
    }
    const timer = setInterval(() => setAngle((value) => value + 0.12), 80);
    return () => clearInterval(timer);
  }, [spinning]);
  const lines = useMemo(() => pentacle(angle, columns, rows), [angle]);
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
