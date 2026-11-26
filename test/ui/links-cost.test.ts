import assert from 'node:assert/strict';
import { test } from 'vitest';
import { linkify } from '../../src/ui/links.js';

// measure this thread so other workers' CPU time cannot skew the ratio
// average a batch because a single parser call can read below the clock's resolution
const sample = (text: string) => {
  const start = process.threadCpuUsage();

  for (let calls = 1; ; calls++) {
    linkify(text, '/work');
    const { user, system } = process.threadCpuUsage(start);

    if (user + system >= 20_000) return Math.round((user + system) / calls);
  }
};

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

const punctuation = (count: number) =>
  `https://example.com/${'.'.repeat(count)}b `.repeat(64);

// the only possible link ends the line, so a cut that rescans the rest of the run on each piece grows with its square
const sparse = (count: number) =>
  JSON.stringify(
    JSON.stringify([
      ...Array.from({ length: count }, (_, k) => ({ k })),
      { email: 'dev@example.com' },
    ]),
  );

const escapedFiles = (count: number) =>
  JSON.stringify(
    JSON.stringify(
      Array.from({ length: count }, (_, n) => ({
        files: `src/a${n}.ts\nsrc/b${n}.ts`,
      })),
    ),
  );

const directories = (count: number) =>
  Array.from({ length: count }, (_, n) => `/opt/t${100000 + n}/bin`).join(':');

const escapedUrls = (count: number) =>
  JSON.stringify(
    Array.from({ length: count }, (_, n) => `https://example.com/${n}`).join(
      '\n',
    ),
  );

test.each([
  ...['-', '.', '@', 'é', '+', ',', '%'].map(
    (character) =>
      [character, character.repeat(16000), character.repeat(64000)] as const,
  ),
  ['lines of links', links(500, '\n'), links(2000, '\n')] as const,
  ['a line of links', links(500, ' '), links(2000, ' ')] as const,
  ['escaped URL lists', escapedUrls(500), escapedUrls(2000)] as const,
  ...(
    [
      ['a link of joined links', 'https://example.com/a;', 4000],
      ['a link with a punctuation run inside', '.', 64000],
      ['unbroken links with a scheme', 'https://example.com/a)(', 4000],
      ['unbroken links with no scheme', 'www.example.com)(', 4000],
      [
        'unbroken links with an unclosed bracket',
        'https://example.com/a(',
        4000,
      ],
    ] as const
  ).map(
    ([name, unit, count]) =>
      [
        name,
        `https://example.com/${unit.repeat(count)}b`,
        `https://example.com/${unit.repeat(count * 4)}b`,
      ] as const,
  ),
  ['a line of JSON emails', emails(500), emails(2000)] as const,
  [
    'bracketed numeric prose',
    JSON.stringify({ t: '[' + '1'.repeat(16000) + 'x' }),
    JSON.stringify({ t: '[' + '1'.repeat(64000) + 'x' }),
  ] as const,
  [
    'nested JSON file references',
    escapedFiles(500),
    escapedFiles(2000),
  ] as const,
  [
    'colon-separated directories',
    directories(16000),
    directories(64000),
  ] as const,
  [
    'nested JSON with its only possible link at the end',
    sparse(32000),
    sparse(128000),
  ] as const,
  [
    'punctuation inside searched links',
    punctuation(400),
    punctuation(1600),
  ] as const,
])('linear link parsing: %s', (input, small, large) => {
  let smallTime = Infinity;
  let largeTime = Infinity;

  // keep the fastest samples and remeasure a failing ratio before rejecting it
  for (
    let round = 0;
    round < 3 || (round < 10 && largeTime >= smallTime * 8);
    round++
  ) {
    smallTime = Math.min(smallTime, sample(small));
    largeTime = Math.min(largeTime, sample(large));
  }

  assert.ok(
    largeTime < smallTime * 8,
    `${input} took ${smallTime} µs of CPU, then ${largeTime} µs for 4x the input`,
  );
});
