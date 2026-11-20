import { access, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { describeMoves, repairMoves } from '../core/repository/move-repair.js';
import { errorMessage } from '../errors.js';
import { Memory, memoryRepository } from '../memory/memory.js';
import { StateStore } from '../persistence/store.js';

export async function runRecoverDirectory(
  root: string,
  source: string,
  apply: boolean,
): Promise<number> {
  try {
    await access(join(root, 'conversations'));
    const store = await StateStore.open(root);
    const destination = await realpath(process.cwd());
    const preview = !apply;

    const report = await repairMoves(
      store,
      new Memory(memoryRepository(store.root)),
      destination,
      {
        declared: {
          from: isAbsolute(source)
            ? normalize(source).replace(/(.)\/$/, '$1')
            : source,
          to: destination,
        },
        preview,
      },
    );

    process.stdout.write(
      `${describeMoves(report, store.root, preview) ?? 'Nothing to recover.'}\n`,
    );

    return apply && report.blocked.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`witch: ${errorMessage(error)}\n`);

    return 1;
  }
}
