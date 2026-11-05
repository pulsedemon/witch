import { Box, Text } from 'ink';
import { sessionStatus } from '../core/coordination-state.js';
import type { Snapshot } from '../core/snapshot.js';
import { plain } from './links.js';
import { piped } from './theme.js';

/** the top row: what the session is doing, its permission mode, and what the user must do to go on. */
export function PhaseRow({
  state,
  reading,
}: {
  state: Snapshot;
  /** scrolled up from live output in the conversation */
  reading: boolean;
}) {
  return (
    <Box height={1}>
      <Text dimColor wrap="truncate-end">
        {piped([
          sessionStatus(state).toUpperCase(),
          ...(state.native?.permissionMode
            ? [plain(state.native.permissionMode).toUpperCase()]
            : []),
          ...(reading ? ['READING EARLIER OUTPUT'] : []),
          ...(state.phase === 'editing'
            ? ['CLOSE THE VS CODE FILE TO FINISH']
            : []),
        ])}
      </Text>
    </Box>
  );
}
