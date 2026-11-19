import { useEffect } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type { Preview as PreviewOwner } from '../core/preview.js';
import { usePreview } from './usePreview.js';
import { tickMs, useTick } from './useTick.js';

export function Preview({
  owner,
  width,
  height,
  request,
}: {
  owner?: PreviewOwner;
  width: number;
  height: number;
  request?: string;
}) {
  const snapshot = usePreview(owner);
  const id = snapshot?.status.id;
  const rows = width > 0 ? Math.max(0, height - 1) : 0;
  const tick = useTick(1, rows > 0 && (snapshot?.status.frames ?? 0) > 1);

  useEffect(() => {
    if (!id) return;

    owner?.placed(id, { columns: width, rows, request });

    return () => owner?.placed(id);
  }, [owner, id, width, rows, request]);

  if (!snapshot || !rows) return null;

  const frame =
    Math.max(0, Math.floor((tick * tickMs - snapshot.startedAt) / tickMs)) %
    snapshot.status.frames;

  return (
    <Box
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      <Text dimColor wrap="truncate-end">
        {snapshot.status.title}
      </Text>
      <Text>
        {snapshot.document.frames[frame]!.slice(0, rows)
          .map((line) => {
            const first =
              wrapAnsi(line, width, {
                hard: true,
                trim: false,
                wordWrap: false,
              }).split('\n')[0] ?? '';

            return `${stringWidth(first) <= width ? first : ''}\u001b[0m`;
          })
          .join('\n')}
      </Text>
    </Box>
  );
}
