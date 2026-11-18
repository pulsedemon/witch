import assert from 'node:assert/strict';
import { test } from 'vitest';
import stripAnsi from 'strip-ansi';
import {
  markdown,
  markdownAppend,
} from '../../../src/ui/transcript/markdown.js';
import { tabbed, uncopied } from '../../../src/ui/transcript/selection.js';

test('nested lists and task lists render indented with each checkbox inline', () => {
  for (const [input, expected] of [
    ['- a\n  - b\n  - c', '• a\n  • b\n  • c'],
    ['- [ ] a\n  - [x] b', '• [ ] a\n  • [x] b'],
    ['- [ ] parent\n\n  - [x] child', '• [ ] parent\n  • [x] child'],
  ] as const)
    assert.equal(stripAnsi(markdown(input, '/work')), expected, input);
});

test('relative link targets resolve against their own base or stay text without one, while web links, absolute targets and bare paths keep theirs', () => {
  const text =
    '[Ports](ports.md) [Line](ports.md:3) [Abs](/work/abs.md) [Web](https://example.com/x) docs/rules.md';

  const links = (output: string, targets: string[]) =>
    targets.every(
      (target) =>
        output.includes(`\u001b]8;;${target}\u0007`) ||
        output.includes(`\u001b]8;copy=target;${target}\u0007`),
    );

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

test('image alt text renders as plain text, and HTML gets the link checks other text gets', () => {
  const forged =
    '\u001b\\]8;;https://evil.example/share\u0007src/app.ts:12\u001b\\]8;;\u0007';

  const output = markdown(
    `Fixed in ![${forged}](x)\n\n<div>\u001b]8;;smb://evil.example/share\u0007name\u001b]8;;\u0007 \u001b]8;;https://example.com/log\u0007log\u001b]8;;\u0007</div>`,
    '/work',
  );

  assert.ok(!output.includes('evil.example'), JSON.stringify(output));

  assert.ok(
    output.includes('\u001b]8;;https://example.com/log\u0007'),
    JSON.stringify(output),
  );

  assert.equal(
    stripAnsi(output),
    'Fixed in [src/app.ts:12]\n\n<div>name log</div>',
  );
});

test('character references render as their characters in text and link targets, while code and backslash escapes keep them literal', () => {
  for (const [input, expected] of [
    ['Tom &amp; Jerry &lt;T&gt;', 'Tom & Jerry <T>'],
    ['a&nbsp;b it&#x27;s', "a\u00a0b it's"],
    ['&copy 2026', '&copy 2026'],
    ['`a &amp;&amp; b` \\&amp;', 'a &amp;&amp; b &amp;'],
    ['```\n&amp;\n```', '&amp;'],
    ['![x &amp; y](a.png)', '[x & y]'],
  ] as const)
    assert.equal(stripAnsi(markdown(input, '/work')), expected, input);

  assert.equal(markdown('&#27;[31mred', '/work'), 'red');

  assert.ok(
    markdown('see https://e.com/?a=1&amp;b=2', '/work').includes(
      '\u001b]8;;https://e.com/?a=1&b=2\u0007',
    ),
  );
});

test('a URL in inline code links to itself, alone, after a command or after a quoted path', () => {
  for (const input of [
    'Run `curl http://localhost:3000/api` to check.',
    'Open `http://localhost:3000/api` now.',
    "See `./My Notes.md' http://localhost:3000/api` now.",
  ])
    assert.ok(
      markdown(input, '/work').includes(
        '\u001b]8;;http://localhost:3000/api\u0007\u001b[4mhttp://localhost:3000/api\u001b[24m\u001b]8;;\u0007',
      ),
      input,
    );
});

test('ordered items number from their start, and continuation lines and code indent under their item text', () => {
  for (const [input, expected] of [
    ['- line1\n  line2', '• line1\n  line2'],
    ['9. a\n10. b\n    more', '9. a\n10. b\n    more'],
    [
      '1. Set:\n\n   ```yaml\n     key: value\n   top: 1\n   ```',
      '1. Set:\n     key: value\n   top: 1',
    ],
    ['- a\n\n  ```\n\n  x\n  ```', '• a\n  \n  x'],
    ['-\ta', '• a'],
  ] as const)
    assert.equal(stripAnsi(markdown(input, '/work')), expected, input);
});

test('headings, emphasis, line breaks, quotes, rules and tables render as terminal text', () => {
  assert.equal(
    stripAnsi(
      markdown(
        '# Plan\n\n**bold** *em* ~~gone~~  \nnext\n\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |',
        '/work',
      ),
    ),
    `Plan\n\nbold em gone\nnext\n\n${uncopied}│ quoted\n\n────────\na ${tabbed}│ b\n1 ${tabbed}│ 2`,
  );

  // a rule the text holds is not one the renderer drew
  assert.equal(
    stripAnsi(markdown('```\n│ x\n```\n\n`a │ b`', '/work')),
    '│ x\n\na │ b',
  );
});

function streamMarkdown(chunks: readonly string[]): string[] {
  let source = '';
  let pending = '';
  let full = false;
  const complete: string[] = [];

  return chunks.map((chunk) => {
    source += chunk;

    const rendered = full
      ? undefined
      : markdownAppend(pending + chunk, '/work');

    let output: string;

    if (rendered) {
      complete.push(...rendered.complete);
      pending = rendered.pending;
      output = [...complete, rendered.tail].join('\n');
    } else {
      full = true;
      output = markdown(source, '/work');
    }

    assert.equal(output, markdown(source, '/work'), JSON.stringify(source));

    return output;
  });
}

for (const [name, source, expected] of [
  [
    'setext heading',
    'Settled.\n\nHeading\n---\n\nAfter',
    'Settled.\n\nHeading\n\nAfter',
  ],
  [
    'setext across thematic lines',
    'Settled.\n\na\n___\nb\n___\nc\n-',
    'Settled.\n\na\n___\nb\n___\nc',
  ],
  [
    'table delimiter',
    'Settled.\n\na | b\n---|---\n1|2\n',
    `Settled.\n\na ${tabbed}│ b\n1 ${tabbed}│ 2`,
  ],
  [
    'list continuation',
    'Settled.\n\n- first\n\n  second\n\nAfter',
    'Settled.\n\n• first\n  second\n\nAfter',
  ],
  [
    'open fence',
    'Settled.\n\n```ts\n\n**literal**\n```\n\nAfter',
    'Settled.\n\n\n**literal**\n\nAfter',
  ],
  [
    'quote continuation',
    'Settled.\n\n> first\n>\n> second\n\nAfter',
    `Settled.\n\n${uncopied}│ first\n${uncopied}│ \n${uncopied}│ second\n\nAfter`,
  ],
  ['empty block', 'first\n\n```\n```\n', 'first'],
  [
    'carriage returns',
    'Settled.\r\n\r\nNext\r\n\r\nAfter',
    'Settled.\n\nNext\n\nAfter',
  ],
  [
    'inline delimiters',
    'Settled.\n\n**bold** *em* &amp; `src/a.ts` [file](src/b.ts:2) e\u0301 🐈\n\nAfter',
    'Settled.\n\nbold em & src/a.ts file e\u0301 🐈\n\nAfter',
  ],
] as const)
  test(`streamed Markdown keeps ${name} correct across every chunk boundary`, () => {
    for (let split = 0; split <= source.length; split++) {
      const frames = streamMarkdown([
        source.slice(0, split),
        source.slice(split),
      ]);

      assert.equal(stripAnsi(frames.at(-1)!), expected);
    }

    assert.equal(stripAnsi(streamMarkdown(source.split('')).at(-1)!), expected);
  });

test('an empty fence opener removes separators until its body arrives', () => {
  const frames = streamMarkdown([
    'first\n\nSecond.\n\n`',
    '`',
    '`',
    '\nbody',
    '\n```',
  ]);

  assert.deepEqual(frames.map(stripAnsi), [
    'first\n\nSecond.\n\n`',
    'first\n\nSecond.\n\n``',
    'first\n\nSecond.',
    'first\n\nSecond.\n\nbody',
    'first\n\nSecond.\n\nbody',
  ]);
});

test('a streamed setext delimiter restyles its earlier line', () => {
  assert.deepEqual(streamMarkdown(['Heading\n', '---\n']), [
    'Heading',
    '\u001b[1mHeading\u001b[22m',
  ]);
});

test('late and nested definitions rebuild earlier references and retain the first target', () => {
  for (const definition of ['[g]: src/guide.ts\n', '> [g]: src/guide.ts\n']) {
    const frames = streamMarkdown([
      '[Guide][g]\n\nSettled.\n\nLast.\n\n',
      definition,
      '\n[g]: wrong.md\n\nAfter',
    ]);

    assert.match(frames[0]!, /^\[Guide\]\[g\]/);

    for (const frame of frames.slice(1)) {
      assert.ok(
        frame.includes(
          '\u001b]8;copy=target;vscode://file/work/src/guide.ts\u0007\u001b[4mGuide',
        ),
      );

      assert.ok(!frame.includes('vscode://file/work/wrong.md'));
    }

    assert.ok(frames.at(-1)!.endsWith('After'));
  }
});

test('HTML state across streamed paragraphs keeps the existing link interpretation', () => {
  const frames = streamMarkdown([
    'Settled.\n\nNext.\n\nfirst <a href="https://example.com">\n\n',
    'www.example',
    '\n\n</a> end',
  ]);

  assert.ok(frames[1]!.endsWith('\n\nwww.example'));

  for (const frame of frames) assert.ok(!frame.includes('http://www.example'));
});
