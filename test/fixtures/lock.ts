import { StateStore } from '../../src/persistence/store.js';
const store = await StateStore.open(process.argv[2]!);
const id = process.argv[3]!;
if (process.argv[4] === 'observe') {
  const limit = Number(process.argv[5]);
  let stopped = false;
  process.stdin.once('end', () => {
    stopped = true;
  });
  process.stdout.write('ready\n');
  process.stdin.once('data', () => {
    void (async () => {
      let attempts = 0;
      let held = 0;
      while (!stopped && (!limit || attempts < limit)) {
        if (await store.isOpen(id)) held++;
        if (++attempts === 1) process.stdout.write('started\n');
      }
      process.stdout.write(`${JSON.stringify({ attempts, held })}\n`);
      process.stdin.destroy();
    })();
  });
} else {
  const files = await store.claim(id);
  process.stdout.write('locked\n');
  process.stdin.once('data', () => {
    void files.close().then(() => process.stdin.destroy());
  });
  process.stdin.resume();
}
