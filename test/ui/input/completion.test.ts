import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  activeToken,
  rankCommands,
  rankFiles,
  tokenKey,
} from '../../../src/ui/input/completion.js';

test('a command token is a whole draft with no whitespace', () => {
  assert.deepEqual(activeToken('/mo', 3), { kind: 'command', query: 'mo' });
  assert.deepEqual(activeToken('/', 1), { kind: 'command', query: '' });
  assert.equal(activeToken('/model x', 8), undefined);
  assert.equal(activeToken('see /mo', 7), undefined);
});

test('a file token is the @ word holding the cursor, and the query ends at the cursor', () => {
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

test('a token key changes with the token text and position but not with the cursor inside it', () => {
  assert.equal(tokenKey('see @sr', 7), tokenKey('see @sr', 6));
  assert.notEqual(tokenKey('see @sr', 7), tokenKey('see @src', 8));
  assert.notEqual(tokenKey('@sr', 3), tokenKey(' @sr', 4));
  assert.equal(tokenKey('plain', 5), undefined);
});

const items = [
  { name: 'models' },
  { name: 'quit', aliases: ['exit'] },
  { name: 'model' },
  { name: 'exit-plan' },
];

const names = (ranked: { name: string }[]) => ranked.map(({ name }) => name);

test('commands rank an exact name or alias first, then name prefixes, in input order', () => {
  assert.deepEqual(names(rankCommands('model', items, [])), [
    'model',
    'models',
  ]);

  assert.deepEqual(names(rankCommands('EXIT', items, [])), [
    'quit',
    'exit-plan',
  ]);

  // a Witch command never matches inside its name or by its initials
  assert.deepEqual(rankCommands('odel', items, []), []);
  assert.deepEqual(rankCommands('ep', items, []), []);
});

test('spells also rank names holding the query, then names it abbreviates', () => {
  assert.deepEqual(names(rankCommands('odel', [], items)), ['models', 'model']);

  assert.deepEqual(
    names(rankCommands('mem', [{ name: 'memory' }], [{ name: 'mem' }])),
    ['mem', 'memory'],
  );

  assert.deepEqual(
    names(
      rankCommands('REV', [], [{ name: 'Code-Review' }, { name: 'review' }]),
    ),
    ['review', 'Code-Review'],
  );

  assert.deepEqual(
    names(
      rankCommands(
        'TDD',
        [],
        [{ name: 'a-tidied' }, { name: 'superpowers:Test-Driven-Development' }],
      ),
    ),
    ['superpowers:Test-Driven-Development'],
  );

  assert.deepEqual(
    names(
      rankCommands('prl', [], [{ name: 'pr-review-loop' }, { name: 'x-prl' }]),
    ),
    ['x-prl', 'pr-review-loop'],
  );

  assert.deepEqual(rankCommands('lrp', [], [{ name: 'pr-review-loop' }]), []);
});

test('files rank path prefixes first, then any path holding the query', () => {
  assert.deepEqual(
    rankFiles('src', ['test/src.ts', 'src/a.ts', 'lib/x.ts', 'Src/b.ts']),
    ['src/a.ts', 'Src/b.ts', 'test/src.ts'],
  );
});
