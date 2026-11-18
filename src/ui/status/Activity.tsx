import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { elapsed } from './elapsed.js';
import { accent, colors, piped } from '../theme.js';

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
}: {
  startedAt: number;
  quietSince?: number;
  reasonedAt?: number;
  doing?: string;
}) {
  const [start] = useState(Date.now);

  const [verb] = useState(
    () => verbs[Math.floor(Math.random() * verbs.length)]!,
  );

  const [now, setNow] = useState(start);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);

    return () => clearInterval(timer);
  }, []);

  const frame = frames[Math.floor((now - start) / 100) % frames.length];

  return (
    <Text wrap="truncate-end">
      {piped([
        colors.hex(accent)(`${frame} ${verb}`),
        colors.dim(elapsed(now - startedAt)),
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
