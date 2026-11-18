import { Box, Text } from 'ink';
import {
  sessionStatus,
  taskActivity,
} from '../../core/coordination/coordination-state.js';
import type { Snapshot } from '../../core/snapshot.js';
import { plain } from '../links.js';
import { piped } from '../theme.js';

/** the top row: what the session is doing, its permission mode, and what the user must do to go on. */
export function PhaseRow({
  state,
  reading,
  counts,
  exitArmed,
  copied,
}: {
  state: Snapshot;
  /** scrolled up from live output in the conversation */
  reading: boolean;
  /** count running familiars and brews, which the sidebar shows when it fits */
  counts: boolean;
  /** a second Ctrl+C now exits */
  exitArmed: boolean;
  /** the clipboard just took a Cmd+C */
  copied: boolean;
}) {
  const { familiars, brews } = taskActivity(state);

  const count = (n: number, name: string) =>
    counts && n ? [`${n} ${name}${n === 1 ? '' : 'S'}`] : [];

  return (
    <Box height={1}>
      <Text dimColor wrap="truncate-end">
        {piped([
          sessionStatus(state).toUpperCase(),
          ...(exitArmed ? ['PRESS CTRL+C AGAIN TO EXIT'] : []),
          ...(copied ? ['COPIED'] : []),
          ...(state.native?.permissionMode
            ? [plain(state.native.permissionMode).toUpperCase()]
            : []),
          ...(reading ? ['READING EARLIER OUTPUT'] : []),
          ...(state.phase === 'editing'
            ? ['CLOSE THE VS CODE FILE TO FINISH']
            : []),
          ...count(familiars, 'FAMILIAR'),
          ...count(brews, 'BREW'),
        ])}
      </Text>
    </Box>
  );
}
