import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

/** redrawn every 5 seconds, as Claude Code refreshes a status line, so the duration and resets keep time. */
export function useStatusTime(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function StatusLine({ lines }: { lines: readonly string[] }) {
  return (
    <Box flexDirection="column" height={lines.length} paddingX={1}>
      {lines.map((line, row) => (
        <Text key={row} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
