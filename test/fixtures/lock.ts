import { StateStore } from '../../src/persistence/store.js';
const store = await StateStore.open(process.argv[2]!);
const files = await store.claim(process.argv[3]!);
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.once('end', () => {
  void files.close();
});
