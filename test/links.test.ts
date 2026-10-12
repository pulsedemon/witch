import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import { hyperlink, linkify, linkTarget } from '../src/ui/links.js';
import { markdown } from '../src/ui/markdown.js';

await test('bare URLs retain their exact browser target across wrapping', () => {
  const url = 'https://iterm2.com/documentation-escape-codes.html';
  const rendered = wrapAnsi(linkify(`Read ${url}.`, '/work'), 24, {
    hard: true,
  });
  assert.ok(rendered.includes(`\u001b]8;;${url}\u0007`));
  assert.equal(stripAnsi(rendered).replaceAll('\n', ''), `Read ${url}.`);
});

await test('relative files resolve against their originating project with encoded spaces and locations', () => {
  assert.equal(
    linkTarget('src/My File.ts:12:4', '/work/My Project'),
    'vscode://file/work/My%20Project/src/My%20File.ts:12:4',
  );
  assert.equal(
    linkTarget('/work/other.ts:7', '/work/My Project'),
    'vscode://file/work/other.ts:7',
  );
  assert.ok(
    linkify('See src/main.ts:42 and README.md.', '/work/project').includes(
      'vscode://file/work/project/src/main.ts:42',
    ),
  );
});

await test('Markdown labels and links in code blocks remain clickable', () => {
  const rendered = markdown(
    '[Documentation](https://example.com/docs)\n\n```text\nhttps://example.com/log\nsrc/main.ts:42\n```',
    '/work/project',
  );
  assert.match(stripAnsi(rendered), /Documentation/);
  for (const target of [
    'https://example.com/docs',
    'https://example.com/log',
    'vscode://file/work/project/src/main.ts:42',
  ])
    assert.ok(rendered.includes(target));
});

await test('long URLs and preexisting terminal hyperlinks keep their targets', () => {
  const url = `https://example.com/search?q=${'x'.repeat(1000)}`;
  assert.ok(linkify(url, '/work').includes(`\u001b]8;;${url}\u0007`));
  const explicit =
    '\u001b]8;;https://example.com\u0007Friendly label\u001b]8;;\u0007';
  assert.ok(linkify(explicit, '/work').includes('https://example.com'));
  assert.equal(stripAnsi(linkify(explicit, '/work')), 'Friendly label');
});

await test('quoted and Markdown file links preserve spaces without linking command names', () => {
  const prose = '/help PageUp/PageDown ↑/↓';
  assert.equal(linkify(prose, '/work'), prose);
  for (const rendered of [
    linkify('"src/My File.ts:3:2"', '/work'),
    markdown('`src/My File.ts:3:2`', '/work'),
    markdown('[Open file](src/My%20File.ts:3:2)', '/work'),
  ]) {
    assert.ok(rendered.includes('vscode://file/work/src/My%20File.ts:3:2'));
    assert.ok(!rendered.includes('%2520'));
  }
});

await test('bare source references take precedence over fuzzy domains while explicit web URLs stay web links', () => {
  for (const file of ['server.py:42', 'foo.sh', 'README.md', 'src/main.py:4']) {
    const rendered = linkify(file, '/work/project');
    assert.ok(rendered.includes(`vscode://file/work/project/${file}`));
    assert.ok(!rendered.includes('http://'));
  }
  for (const url of [
    'https://server.py:42',
    'https://example.com/path?file=README.md',
  ])
    assert.ok(linkify(url, '/work').includes(`\u001b]8;;${url}\u0007`));
  assert.ok(linkify('example.com', '/work').includes('http://example.com'));
});

await test('malformed file URLs remain readable without breaking a persisted transcript', () => {
  assert.equal(
    stripAnsi(markdown('[Open report](file:///tmp/100%.txt)', '/work')),
    'Open report',
  );
  assert.equal(
    stripAnsi(
      linkify('\u001b]8;;file://%\u0007Invalid path\u001b]8;;\u0007', '/work'),
    ),
    'Invalid path',
  );
});

await test('long runs of dashes, dots and @ signs, and links on many lines or one, link in linear time', () => {
  // this process's CPU time ignores load from parallel tests; 4x the input costs 4x when linear, 16x when quadratic
  const fastest = (text: string) =>
    Math.min(
      ...[1, 2, 3].map(() => {
        const start = process.cpuUsage();
        linkify(text, '/work');
        const { user, system } = process.cpuUsage(start);
        return user + system;
      }),
    );
  const links = (count: number, separator: string) =>
    Array.from(
      { length: count },
      (_, n) => `dev${n}@example.com https://example.com/${n}`,
    ).join(separator);
  // minified, as an API returns it: no whitespace to cut at
  const emails = (count: number) =>
    JSON.stringify(
      Array.from({ length: count }, (_, n) => ({
        email: `dev${n}@example.com`,
      })),
    );
  for (const [input, small, large] of [
    ...['-', '.', '@'].map(
      (character) =>
        [character, character.repeat(16000), character.repeat(64000)] as const,
    ),
    ['lines of links', links(500, '\n'), links(2000, '\n')] as const,
    ['a line of links', links(500, ' '), links(2000, ' ')] as const,
    ['a line of JSON emails', emails(500), emails(2000)] as const,
  ]) {
    const smallTime = fastest(small);
    const largeTime = fastest(large);
    assert.ok(
      largeTime < smallTime * 8,
      `${input} took ${smallTime} µs of CPU, then ${largeTime} µs for 4x the input`,
    );
  }
});

await test('text past 2000 characters is cut after a newline, else after a space, < or >, else after a quote, so a link across the cut stays whole', () => {
  const file = `src/notes ${'n'.repeat(20)}.md`;
  for (const [text, target] of [
    [
      `${'x'.repeat(1990)} https://example.com/abcdef end`,
      'https://example.com/abcdef',
    ],
    // the space inside the quotes is the last whitespace before the cut
    [
      `${'x'.repeat(1980)}\n"${file}" end`,
      `vscode://file/work/${file.replace(' ', '%20')}`,
    ],
    [
      `${'x'.repeat(1990)}<https://example.com/abcdef>end`,
      'https://example.com/abcdef',
    ],
    [
      `${'x'.repeat(1990)}"https://example.com/abcdef"]`,
      'https://example.com/abcdef',
    ],
  ] as const) {
    const output = linkify(text, '/work');
    assert.ok(output.includes(`\u001b]8;;${target}\u0007`), target);
    assert.equal(stripAnsi(output), text);
  }
  const unbroken = 'x'.repeat(5000);
  assert.equal(linkify(unbroken, '/work'), unbroken);
});

await test('multi-dot names, dotfiles and quoted or prefixed paths after a dash link whole', () => {
  for (const [text, target] of [
    ['test/claude.test.ts:3', 'vscode://file/work/test/claude.test.ts:3'],
    ['.eslintrc.json', 'vscode://file/work/.eslintrc.json'],
    ['dir/.hidden.ts', 'vscode://file/work/dir/.hidden.ts'],
    ['-"src/a b.ts"', 'vscode://file/work/src/a%20b.ts'],
    ['x-~/notes.md', `vscode://file${homedir()}/notes.md`],
  ] as const)
    assert.ok(
      linkify(text, '/work').includes(`\u001b]8;;${target}\u0007`),
      text,
    );
});

await test('a web target with a control character stays plain text', () => {
  assert.equal(
    hyperlink('label', 'https://example.com/\u001b]8;;x', '/work'),
    'label',
  );
});
