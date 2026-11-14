import type { Dispatch, SetStateAction } from 'react';
import { Box, Text } from 'ink';
import { ScrollPage } from './ScrollPage.js';
import { piped } from './theme.js';
import { wrapLines } from './wrap.js';

export function Recovery({
  conflict,
  lines,
  height,
  width,
  scroll,
  setScroll,
}: {
  conflict: boolean;
  lines: readonly string[];
  height: number;
  width: number;
  scroll: number;
  setScroll: Dispatch<SetStateAction<number>>;
}) {
  const heading = Number(height >= 3);

  const explanation = conflict
    ? 'Another conversation published changes to the same notes. Keep mine merges your current changes.'
    : 'Accept these changes with their original attribution, or discard them.';

  const hints = wrapLines(
    piped([
      ...(conflict
        ? [
            'k KEEP MINE (YOUR SIDE OF EACH CONFLICTING CHANGE WINS)',
            'd DISCARD MINE',
          ]
        : ['a ACCEPT', 'd DISCARD']),
      '↑/↓ SCROLL',
      'CTRL+C QUIT',
    ]),
    width,
  );

  const hintRows = Math.min(hints.length, Math.max(1, height - heading - 2));

  const explanationRows = Math.min(
    wrapLines(explanation, width).length,
    Math.max(0, height - heading - hintRows - 1),
  );

  const pageRows = Math.min(
    height - heading - explanationRows - hintRows,
    Math.max(1, height - 5),
  );

  return (
    <Box flexDirection="column" height={height}>
      {heading > 0 && (
        <Text color="yellow" bold wrap="truncate-end">
          {conflict
            ? 'Memory conflicts with another conversation'
            : 'Unfinished memory changes'}
        </Text>
      )}
      <Box height={explanationRows} overflow="hidden" flexShrink={0}>
        <Text>{explanation}</Text>
      </Box>
      <ScrollPage
        lines={lines}
        height={pageRows}
        scroll={scroll}
        setScroll={setScroll}
        arrows
      />
      <Box height={hintRows} overflow="hidden" flexShrink={0}>
        <Text bold>{hints.slice(0, hintRows).join('\n')}</Text>
      </Box>
    </Box>
  );
}
