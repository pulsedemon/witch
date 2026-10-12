import assert from 'node:assert/strict';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import { markdown } from '../src/ui/markdown.js';

await test('nested lists and task lists render indented with each checkbox inline', () => {
  for (const [input, expected] of [
    ['- a\n  - b\n  - c', '• a\n  • b\n  • c'],
    ['- [ ] a\n  - [x] b', '• [ ] a\n  • [x] b'],
    ['- [ ] parent\n\n  - [x] child', '• [ ] parent\n  • [x] child'],
  ] as const)
    assert.equal(stripAnsi(markdown(input, '/work')), expected, input);
});

await test('image alt text renders as plain text, so it cannot carry a link of its own', () => {
  const forged =
    '\u001b\\]8;;smb://evil.example/share\u0007src/app.ts:12\u001b\\]8;;\u0007';
  const output = markdown(`Fixed in ![${forged}](x)`, '/work');
  assert.ok(!output.includes('smb:'), JSON.stringify(output));
  assert.equal(stripAnsi(output), 'Fixed in [src/app.ts:12]');
});

await test('ordered items number from their start, and a continuation line indents under its item text', () => {
  for (const [input, expected] of [
    ['- line1\n  line2', '• line1\n  line2'],
    ['9. a\n10. b\n    more', '9. a\n10. b\n    more'],
  ] as const)
    assert.equal(stripAnsi(markdown(input, '/work')), expected, input);
});

await test('headings, emphasis, quotes, rules and tables render as terminal text', () => {
  assert.equal(
    stripAnsi(
      markdown(
        '# Plan\n\n**bold** *em* ~~gone~~\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |',
        '/work',
      ),
    ),
    'Plan\n\nbold em gone\n\n│ quoted\n\n────────\na │ b\n1 │ 2',
  );
});
