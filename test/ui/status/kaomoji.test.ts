import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { test } from 'vitest';
import { kaomoji } from '../../../src/ui/status/kaomoji.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

test('the face pool has unique entries whose graphemes fit Ghostty cells', () => {
  assert.equal(new Set(kaomoji).size, kaomoji.length);

  for (const face of kaomoji)
    for (const { segment } of graphemes.segment(face))
      assert.ok(stringWidth(segment) <= 2, `${face}: ${segment}`);
});
