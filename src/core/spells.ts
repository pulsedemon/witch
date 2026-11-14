import type { Cast } from '../agents/types.js';

import type { DisplayUpdate } from './state.js';

export function castRow(
  cast: Cast,
  cwd: string,
  familiar?: string,
): DisplayUpdate {
  const name = `\`${cast.name}\``;

  return {
    id: `spell/${cast.id}`,
    kind: 'notice',
    cast: true,
    text: familiar ? `Familiar ${familiar} cast ${name}` : `Cast ${name}`,
    cwd,
  };
}
