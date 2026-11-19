import { useState } from 'react';
import { Text } from 'ink';
import { elapsed } from './elapsed.js';
import { accent, colors, piped } from '../theme.js';
import { tickMs, useTick } from '../useTick.js';

const verbs = [
  'CONJURING',
  'SCRYING',
  'BREWING',
  'DIVINING',
  'INCANTING',
  'SUMMONING',
  'HEXING',
  'TRANSMUTING',
];

const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** the row above the composer while the agent works, since a model can think for many seconds before it shows anything. */
export function Activity({
  startedAt,
  quietSince,
  reasonedAt,
  doing,
  compacting,
}: {
  startedAt: number;
  quietSince?: number;
  reasonedAt?: number;
  doing?: string;
  compacting?: boolean;
}) {
  const [verb] = useState(
    () => verbs[Math.floor(Math.random() * verbs.length)]!,
  );

  const step = useTick(2);
  const [start] = useState(step);
  const now = step * 2 * tickMs;
  const frame = frames[(step - start) % frames.length];

  return (
    <Text wrap="truncate-end">
      {piped([
        colors.hex(accent)(`${frame} ${compacting ? 'COMPACTING' : verb}`),
        colors.dim(elapsed(Math.max(0, now - startedAt))),
        colors.dim('ESC TO INTERRUPT'),
        ...(quietSince === undefined
          ? []
          : [
              // the clock ticks behind an update that just arrived
              colors.dim(`QUIET ${elapsed(Math.max(0, now - quietSince))}`),
            ]),
        ...(reasonedAt === undefined
          ? []
          : [
              colors.dim(
                `THOUGHT ${elapsed(Math.max(0, now - reasonedAt))} AGO`,
              ),
            ]),
        ...(doing ? [colors.dim(doing)] : []),
      ])}
    </Text>
  );
}
