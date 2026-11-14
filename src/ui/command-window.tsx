import { Box, Text } from 'ink';
import type { DisplayItem } from '../core/state.js';
import { oneLine } from './links.js';
import { commandWindowRows } from './chat-layout.js';

export function CommandWindow({
  items,
  height = commandWindowRows,
}: {
  items: readonly DisplayItem[];
  height?: number;
}) {
  const calls = items.filter(
    (item) => item.kind === 'tool' && item.id.includes('/') && !item.shell,
  );

  const recent = height > 1 ? calls.slice(-(height - 1)) : [];
  const running = calls.filter((item) => !item.done).length;
  const older = running - recent.filter((item) => !item.done).length;

  return (
    <Box
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      <Text dimColor wrap="truncate-end">
        {`TOOLS${calls.length ? ` · ${running} RUNNING` : ''}${older ? ` · ${older} OLDER` : ''}`}
      </Text>
      {recent.length ? (
        recent.map((item) => (
          <Text key={item.id} wrap="truncate-end">
            <Text
              color={item.done && item.failed ? 'red' : undefined}
              dimColor={!item.failed}
            >
              {item.done ? (item.failed ? '✗' : '✓') : '…'}
            </Text>
            <Text dimColor>{` ${oneLine(item.title || 'Tool')}`}</Text>
          </Text>
        ))
      ) : (
        <Text dimColor>No recent tools</Text>
      )}
    </Box>
  );
}
