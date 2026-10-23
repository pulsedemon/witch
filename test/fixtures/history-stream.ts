import { StateStore } from '../../src/persistence/store.js';

const store = await StateStore.open(process.argv[2]!);
const files = await store.claim(process.argv[3]!);
const kind = process.argv[4] === 'tool' ? 'tool' : 'assistant';
const update = { id: 'stream', kind, cwd: '/project', done: false } as const;
process.stdin.resume();
await Promise.all([
  files.append({ ...update, text: 'first' }),
  files.append({ ...update, text: 'second' }),
]);
process.stdout.write('written\n');
