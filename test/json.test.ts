import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { z } from 'zod';
import { readJson } from '../src/persistence/json.js';
import { scratch } from './fixtures/scratch.js';

test('a JSON file under a stray file, as under a Finder .DS_Store, reads as missing', async () => {
  const root = await scratch('witch-json-');
  await writeFile(join(root, '.DS_Store'), '');
  assert.equal(
    await readJson(join(root, '.DS_Store', 'state.json'), z.unknown()),
    undefined,
  );
});
