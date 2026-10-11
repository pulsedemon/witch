import { StateStore } from '../../src/persistence/store.js';
const store = await StateStore.open(process.argv[2]!);
process.stdout.write('locked\n');
process.stdin.resume();
process.stdin.once('end', () => {
  void store.close();
});
