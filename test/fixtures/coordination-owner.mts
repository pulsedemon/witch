import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ClaimConflict,
  CoordinationStore,
} from '../../src/persistence/coordination.js';

const [root, conversation] = process.argv.slice(2);
const store = await CoordinationStore.open(root!);
const timer = setTimeout(() => process.exit(1), 10_000);
process.once('message', () => {
  void (async () => {
    try {
      const claim = await store.claim(
        { conversation: conversation!, project: 'project-p' },
        { reference: 'task:shared', summary: `Work ${conversation}` },
        Date.now() + 5000,
        async () => {},
      );
      await writeFile(join(root!, `${conversation}.worked`), claim.id);
      process.send!({ kind: 'claimed', claim });
    } catch (error) {
      process.send!(
        error instanceof ClaimConflict
          ? { kind: 'conflict', claim: error.claim }
          : { kind: 'error', message: String(error) },
      );
    } finally {
      clearTimeout(timer);
      process.disconnect();
    }
  })();
});
process.send!({ kind: 'ready' });
