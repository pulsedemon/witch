import assert from 'node:assert/strict';
import { test } from 'node:test';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import { linkify, linkTarget } from '../src/ui/links.js';
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
