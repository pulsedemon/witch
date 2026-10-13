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

await test('relative link targets resolve against their own base or stay text without one, while web links, absolute targets and bare paths keep theirs', () => {
  const text =
    '[Ports](ports.md) [Line](ports.md:3) [Abs](/work/abs.md) [Web](https://example.com/x) docs/rules.md';
  const links = (output: string, targets: string[]) =>
    targets.every((target) => output.includes(`\u001b]8;;${target}\u0007`));
  const kept = [
    'vscode://file/work/abs.md',
    'https://example.com/x',
    'vscode://file/work/docs/rules.md',
  ];
  assert.ok(
    links(markdown(text, '/work', '/memory/global'), [
      'vscode://file/memory/global/ports.md',
      'vscode://file/memory/global/ports.md:3',
      ...kept,
    ]),
  );
  const unlinked = markdown(text, '/work', null);
  assert.ok(links(unlinked, kept));
  assert.ok(!unlinked.includes('ports.md'));
});

await test('image alt text and HTML render as plain text, so neither can carry a link of its own', () => {
  const forged =
    '\u001b\\]8;;https://evil.example/share\u0007src/app.ts:12\u001b\\]8;;\u0007';
  const output = markdown(
    `Fixed in ![${forged}](x)\n\n<div>\u001b]8;;smb://evil.example/share\u0007name\u001b]8;;\u0007</div>`,
    '/work',
  );
  assert.ok(!output.includes('evil.example'), JSON.stringify(output));
  assert.equal(
    stripAnsi(output),
    'Fixed in [src/app.ts:12]\n\n<div>name</div>',
  );
});

await test('a URL in inline code links to itself, alone, after a command or after a quoted path', () => {
  for (const input of [
    'Run `curl http://localhost:3000/api` to check.',
    'Open `http://localhost:3000/api` now.',
    "See `./My Notes.md' http://localhost:3000/api` now.",
  ])
    assert.ok(
      markdown(input, '/work').includes(
        '\u001b]8;;http://localhost:3000/api\u0007http://localhost:3000/api\u001b]8;;\u0007',
      ),
      input,
    );
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
