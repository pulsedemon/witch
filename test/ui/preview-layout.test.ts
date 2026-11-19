import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Preview } from '../../src/core/preview.js';
import { previewLayout } from '../../src/ui/preview-layout.js';

test('preview allocation preserves transcript or question rows and needs room for a title and frame', () => {
  const owner = new Preview();

  const status = owner.show({
    title: 'Tall',
    frames: [Array(20).fill('frame')],
  });

  assert.deepEqual(previewLayout(15, 2, status), { preview: 13, body: 2 });
  assert.deepEqual(previewLayout(15, 6, status), { preview: 9, body: 6 });
  assert.deepEqual(previewLayout(6, 6, status), { preview: 0, body: 6 });
  assert.deepEqual(previewLayout(7, 6, status), { preview: 0, body: 7 });
  assert.deepEqual(previewLayout(30, 6, status), { preview: 21, body: 9 });
  assert.deepEqual(previewLayout(15, 2), { preview: 0, body: 15 });
});
