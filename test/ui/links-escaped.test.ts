import assert from 'node:assert/strict';
import stripAnsi from 'strip-ansi';
import { test } from 'vitest';
import { markdown } from '../../src/ui/transcript/markdown.js';

function assertLinks(text: string, targets: string[]) {
  const output = markdown('```json\n' + text + '\n```', '/work');

  const spans = output
    .split('\u001b]8;;')
    .slice(1)
    .flatMap((chunk) => {
      const end = chunk.indexOf('\u0007');

      return end > 0
        ? [
            {
              target: chunk.slice(0, end),
              text: stripAnsi(chunk.slice(end + 1)),
            },
          ]
        : [];
    });

  assert.deepEqual(
    spans,
    targets.map((target) => ({ target, text: target })),
  );

  assert.equal(stripAnsi(output), text);
}

test('long JSON strings retain every escaped-newline URL through the Markdown renderer', () => {
  const urls = Array.from(
    { length: 120 },
    (_, n) => `https://example.com/${n}`,
  );

  for (const separator of ['\n', '\r', '\t']) {
    const text = JSON.stringify({ urls: urls.join(separator) });
    assertLinks(text, urls);
    assertLinks(JSON.stringify(text), urls);
  }
});

test('oversized values beside JSON escapes stay unlinked without hiding a neighboring URL', () => {
  const after = 'https://example.com/after';

  for (const value of [
    `https://example.com/${'a'.repeat(2500)}`,
    `./${'a'.repeat(2500)}.ts`,
    `/tmp/${'a'.repeat(2500)}`,
  ]) {
    assertLinks(JSON.stringify({ text: `${value}\n${after}` }), [after]);
    assertLinks(JSON.stringify({ text: `${after}\n${value}` }), [after]);
  }
});

test('escape recovery never exposes a partial oversized terminal path', () => {
  assertLinks(`/tmp/${'a'.repeat(2500)}\\notes.ts`, []);
  assertLinks(`/tmp/${'a'.repeat(2500)}\\nexample.com/notes`, []);

  assertLinks(
    `/tmp/${'a'.repeat(1800)}\\nhttps://example.com/${'b'.repeat(2200)}.ts`,
    [],
  );
});

test('JSON escape bytes do not count against the 2000-character URL limit', () => {
  const prefix = 'https://example.com/';
  const after = `${prefix}after`;

  for (const length of [1999, 2000, 2001]) {
    const url = prefix + 'a'.repeat(length - prefix.length);
    const text = JSON.stringify({ urls: `${url}\n${after}` });
    const targets = length <= 2000 ? [url, after] : [after];
    assertLinks(text, targets);
    assertLinks(JSON.stringify(text), targets);
  }
});
