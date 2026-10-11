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

await test('a list item continuation line indents under its text', () => {
  assert.equal(
    stripAnsi(markdown('- line1\n  line2', '/work')),
    '• line1\n  line2',
  );
});
