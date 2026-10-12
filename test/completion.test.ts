import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeToken,
  rankCommands,
  rankFiles,
  tokenKey,
} from '../src/ui/completion.js';

await test('a command token is the whole draft, up to its first whitespace', () => {
  assert.deepEqual(activeToken('/mo', 3), { kind: 'command', query: 'mo' });
  assert.deepEqual(activeToken('/', 1), { kind: 'command', query: '' });
  assert.equal(activeToken('/model x', 8), undefined);
  assert.equal(activeToken('see /mo', 7), undefined);
});

await test('a file token is the @ word holding the cursor, and the query ends at the cursor', () => {
  assert.deepEqual(activeToken('see @src/ui x', 11), {
    kind: 'file',
    query: 'src/ui',
    start: 4,
    end: 11,
  });
  assert.deepEqual(activeToken('see @src/ui x', 8), {
    kind: 'file',
    query: 'src',
    start: 4,
    end: 11,
  });
  assert.equal(activeToken('see @src x', 4), undefined);
  assert.equal(activeToken('mail a@b', 8), undefined);
  assert.deepEqual(activeToken('one\n@n', 6), {
    kind: 'file',
    query: 'n',
    start: 4,
    end: 6,
  });
});

await test('a token key changes with the token text and position but not with the cursor inside it', () => {
  assert.equal(tokenKey('see @sr', 7), tokenKey('see @sr', 6));
  assert.notEqual(tokenKey('see @sr', 7), tokenKey('see @src', 8));
  assert.notEqual(tokenKey('@sr', 3), tokenKey(' @sr', 4));
  assert.equal(tokenKey('plain', 5), undefined);
});

await test('commands rank an exact name or alias first, then name prefixes, in input order', () => {
  const items = [
    { name: 'models' },
    { name: 'quit', aliases: ['exit'] },
    { name: 'model' },
    { name: 'exit-plan' },
  ];
  assert.deepEqual(
    rankCommands('model', items).map(({ name }) => name),
    ['model', 'models'],
  );
  assert.deepEqual(
    rankCommands('EXIT', items).map(({ name }) => name),
    ['quit', 'exit-plan'],
  );
  assert.deepEqual(rankCommands('odel', items), []);
});

await test('files rank path prefixes first, then any path holding the query', () => {
  assert.deepEqual(
    rankFiles('src', ['test/src.ts', 'src/a.ts', 'lib/x.ts', 'Src/b.ts']),
    ['src/a.ts', 'Src/b.ts', 'test/src.ts'],
  );
});
