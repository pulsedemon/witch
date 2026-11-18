import assert from 'node:assert/strict';
import { test } from 'vitest';
import { destination } from '../../src/ui/link-destination.js';

test('a file link copies its decoded path, with the line and column of an editor link', () => {
  assert.equal(
    destination('vscode://file/work/a%20b.ts:3:4'),
    '/work/a b.ts:3:4',
  );

  assert.equal(destination('file:///work/img/a%20b.png'), '/work/img/a b.png');
});
