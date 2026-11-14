import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { identifyProcess } from '../../src/persistence/process.js';

import {
  ClaimConflict,
  CoordinationStore,
} from '../../src/persistence/coordination.js';

import { StateStore } from '../../src/persistence/store.js';

const [root, conversation] = process.argv.slice(2);

const store = await CoordinationStore.open(await StateStore.open(root!));

const identity = (await identifyProcess(process.pid))!;

setTimeout(() => process.exit(1), 30_000);

process.once('message', () => {
  void (async () => {
    try {
      const claim = await store.claim(
        { conversation: conversation!, project: 'project-p' },
        { reference: 'task:shared', summary: `Work ${conversation}` },
        identity,
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
    }
  })();
});

process.send!({ kind: 'ready' });
