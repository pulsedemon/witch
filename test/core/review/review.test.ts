import assert from 'node:assert/strict';
import { test } from 'vitest';
import { shellWords } from '../../../src/agents/tool-title.js';
import {
  afterCorrection,
  brief,
  changes,
  correctionPrompt,
  decide,
  parseFindings,
  reviewerCommand,
  scopeFor,
} from '../../../src/core/review/review.js';
import type {
  Finding,
  Review,
  Round,
} from '../../../src/core/review/review.js';

const finding = (
  line: number,
  blocking: boolean,
  file = 'plan.md',
): Finding => ({
  file,
  line,
  blocking,
  summary: `summary ${line}`,
  correction: `correction ${line}`,
});

const review = (runtime: string, ...findings: Finding[]): Review => ({
  runtime,
  findings,
});

const both: Round = { number: 1, scope: 'full', runtimes: ['claude', 'codex'] };
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

test('parseFindings reads only the last json block and normalizes paths, and says why it read none', () => {
  const report = (file: string) =>
    `notes\n\n${json({ findings: [{ ...finding(3, true), file }] })}\n`;

  assert.deepEqual(parseFindings(report('./plan.md'), '/w/repo', ['plan.md']), [
    finding(3, true),
  ]);

  assert.deepEqual(
    parseFindings(report('/w/repo/plan.md'), '/w/repo', ['plan.md']),
    [finding(3, true)],
  );

  // a fence mentioned in prose isn't one, and a list item's indented fence still is
  assert.deepEqual(
    parseFindings(
      `I end with a \`\`\`json block.\n\n${json({ findings: [] })}\n`,
      '/w/repo',
      [],
    ),
    [],
  );

  assert.deepEqual(
    parseFindings(
      '- result\n\n  ```json\n  {"findings": []}\n  ```\n',
      '/w/repo',
      [],
    ),
    [],
  );

  const invalid = (report: string) => {
    const parsed = parseFindings(report, '/w/repo', ['plan.md']);
    assert.ok('invalid' in parsed, JSON.stringify(parsed));

    return parsed.invalid;
  };

  assert.equal(
    invalid(report('/other/plan.md')),
    '/other/plan.md is not a review target',
  );

  assert.equal(
    invalid('Familiar reporting failed: timeout'),
    'no closed json block',
  );

  assert.match(
    invalid(
      `${json({ findings: [] })}\n\n\`\`\`json\n{"findings": [\n\`\`\`\n`,
    ),
    /JSON/,
  );

  assert.equal(
    invalid(`${json({ findings: [] })}\n\n\`\`\`json\n{"findings": [\n`),
    'a json block opens after the last closed one',
  );

  for (const [value, reason] of [
    [
      { findings: [], error: 'could not read the targets' },
      /^Unrecognized key: "error"$/,
    ],
    [
      {
        findings: [{ ...finding(3, true), file: 'plan.md', severity: 'high' }],
      },
      /^findings\.0: Unrecognized key: "severity"$/,
    ],
    [
      { findings: [{ ...finding(0, true), file: 'plan.md' }] },
      /^findings\.0\.line: /,
    ],
  ] as const)
    assert.match(invalid(json(value)), reason);
});

test('changes counts deletions', () => {
  const tail = changes({ 'plan.md': 'a\nb\nc\nd\n' }, { 'plan.md': 'a\n' });
  assert.equal(tail.ratio, 3);
  assert.equal(tail.changed.get('plan.md'), undefined);
  const middle = changes({ 'plan.md': 'a\nb\nc\n' }, { 'plan.md': 'a\nc\n' });
  assert.equal(middle.ratio, 1 / 2);
  assert.equal(middle.changed.get('plan.md'), undefined);
});

test('changes maps a replacement to its added line', () => {
  const replaced = changes(
    { 'plan.md': 'a\nb\nc\n' },
    { 'plan.md': 'a\nB\nc\n' },
  );

  assert.deepEqual(replaced.changed.get('plan.md'), new Set([2]));
  assert.equal(replaced.ratio, 2 / 3);
  assert.match(replaced.diff, /^-b$/m);
  assert.match(replaced.diff, /^\+B$/m);
});

test('a quiet harness sits out the next round', () => {
  const decided = decide({
    round: both,
    reviews: [review('claude', finding(3, true)), review('codex')],
  });

  assert.ok('blockers' in decided);

  assert.deepEqual(
    afterCorrection({
      round: both,
      blockers: decided.blockers.length,
      sittingOut: decided.sittingOut,
      changedDuring: true,
    }),
    {
      next: { number: 2, closing: false },
      sittingOut: [
        {
          runtime: 'codex',
          why: 'its reviewers found no blockers in round 1',
        },
      ],
    },
  );
});

test('a change in a single-harness round brings every harness back', () => {
  const round: Round = { number: 2, scope: 'diff', runtimes: ['claude'] };

  const decided = decide({
    round,
    reviews: [review('claude', finding(9, true))],
    previousChanges: new Map([['plan.md', new Set([3])]]),
  });

  assert.ok('blockers' in decided);

  assert.deepEqual(
    afterCorrection({
      round,
      blockers: 1,
      sittingOut: decided.sittingOut,
      changedDuring: true,
    }),
    { next: { number: 3, closing: false }, sittingOut: [] },
  );
});

test('a quiet diff round runs one closing pass with everyone', () => {
  const round: Round = { number: 2, scope: 'diff', runtimes: ['claude'] };
  const decided = decide({ round, reviews: [review('claude')] });
  assert.deepEqual(decided, { blockers: [], sittingOut: [] });

  assert.deepEqual(
    afterCorrection({
      round,
      blockers: 0,
      sittingOut: [],
      changedDuring: false,
    }),
    { next: { number: 3, closing: true }, sittingOut: [] },
  );
});

test('a quiet full pass settles', () => {
  assert.deepEqual(
    decide({
      round: both,
      reviews: [review('claude', finding(3, false)), review('codex')],
    }),
    { stop: 'settled: round 1 found no blockers in a full pass' },
  );
});

test('a single routed runtime settles on its own', () => {
  const second: Round = { number: 2, scope: 'diff', runtimes: ['claude'] };

  assert.deepEqual(
    afterCorrection({
      round: second,
      blockers: 0,
      sittingOut: [],
      changedDuring: false,
    }),
    { next: { number: 3, closing: true }, sittingOut: [] },
  );

  assert.deepEqual(
    decide({
      round: { number: 3, scope: 'full', runtimes: ['claude'] },
      reviews: [review('claude')],
    }),
    { stop: 'settled: round 3 found no blockers in a full pass' },
  );
});

test('blockers in the previous corrections stop after their correction', () => {
  const round: Round = { number: 2, scope: 'full', runtimes: ['claude'] };

  const decided = decide({
    round,
    reviews: [review('claude', finding(3, true))],
    previousChanges: new Map([['plan.md', new Set([3])]]),
  });

  assert.ok('blockers' in decided);

  assert.equal(
    decided.stopAfter,
    'every blocker sat on lines corrected since the last round',
  );

  assert.deepEqual(
    afterCorrection({
      round,
      blockers: 1,
      sittingOut: decided.sittingOut,
      stopAfter: decided.stopAfter,
      changedDuring: true,
    }),
    {
      stop: 'every blocker sat on lines corrected since the last round',
      ok: true,
    },
  );
});

test('the regression stop needs every blocker', () => {
  const decided = decide({
    round: both,
    reviews: [
      review('claude', finding(3, true), finding(3, true, 'other.md')),
      review('codex'),
    ],
    previousChanges: new Map([['plan.md', new Set([3])]]),
  });

  assert.ok('blockers' in decided);
  assert.equal(decided.stopAfter, undefined);
});

test('deleting the line before a blocker is not a regression', () => {
  const { changed } = changes(
    { 'plan.md': 'a\nb\nc\n' },
    { 'plan.md': 'a\nc\n' },
  );

  const decided = decide({
    round: both,
    reviews: [review('claude', finding(2, true)), review('codex')],
    previousChanges: changed,
  });

  assert.ok('blockers' in decided);
  assert.equal(decided.stopAfter, undefined);
});

test('a regression stop wins over the recall', () => {
  const round: Round = { number: 2, scope: 'diff', runtimes: ['claude'] };

  const decided = decide({
    round,
    reviews: [review('claude', finding(3, true))],
    previousChanges: new Map([['plan.md', new Set([3])]]),
  });

  assert.ok('blockers' in decided);

  assert.deepEqual(
    afterCorrection({
      round,
      blockers: 1,
      sittingOut: decided.sittingOut,
      stopAfter: decided.stopAfter,
      changedDuring: true,
    }),
    {
      stop: 'every blocker sat on lines corrected since the last round',
      ok: true,
    },
  );
});

test('unapplied blockers stop the loop', () => {
  for (const stopAfter of [undefined, 'regression'])
    assert.deepEqual(
      afterCorrection({
        round: both,
        blockers: 1,
        sittingOut: [],
        ...(stopAfter ? { stopAfter } : {}),
        changedDuring: false,
      }),
      { stop: 'the blockers were not applied', ok: false },
    );
});

test('scopeFor gives round 1, closing passes and large diffs a full pass', () => {
  assert.equal(scopeFor({ number: 1, closing: false }, 0), 'full');
  assert.equal(scopeFor({ number: 4, closing: true }, 0), 'full');
  assert.equal(scopeFor({ number: 4, closing: false }, 0.6), 'full');
  assert.equal(scopeFor({ number: 4, closing: false }, 0.5), 'diff');
});

test("reviewerCommand builds each wrapper's command", () => {
  const words = (command: string) => shellWords(command)!;

  const claude = words(
    reviewerCommand({
      prefix: "'/bin/node' '/w/cli.js' '--control-dir' '/s/familiars'",
      route: { runtime: 'claude', model: 'claude-opus-5-5', reason: 'r' },
      name: 'review-1a2b3c4d-1-claude-0',
      reportFile: '/s/review dir/claude.md',
      briefFile: '/s/review dir/brief.md',
    }),
  );

  assert.deepEqual(claude.words, [
    '/bin/node',
    '/w/cli.js',
    '--control-dir',
    '/s/familiars',
    '--familiar-claude',
    'review-1a2b3c4d-1-claude-0',
    '--report-file',
    '/s/review dir/claude.md',
    '--',
    '--model',
    'claude-opus-5-5',
    '--tools',
    'Read',
    'Grep',
    'Glob',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    '--permission-prompts',
    'none',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
  ]);

  assert.equal(claude.rest.trim(), "< '/s/review dir/brief.md'");

  const codex = words(
    reviewerCommand({
      prefix: "'/bin/node'",
      route: { runtime: 'codex', model: 'gpt-6.1-astra', reason: 'r' },
      name: 'n',
      reportFile: '/s/codex.md',
      briefFile: '/s/brief.md',
    }),
  );

  assert.deepEqual(codex.words.slice(1), [
    '--familiar-codex',
    'n',
    '--report-file',
    '/s/codex.md',
    '--without-mcp',
    '--',
    '-c',
    'model="gpt-6.1-astra"',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'approval_policy="never"',
  ]);
});

test('brief carries the diff for a diff round and asks for the full text in a full pass', () => {
  const known = [{ file: 'plan.md', line: 4, message: 'em dash in prose' }];

  const diffed = brief({
    files: ['plan.md', 'docs/b.md'],
    scope: 'diff',
    diff: '@@ -1 +1 @@\n-a\n+b\n',
    known,
  });

  assert.match(diffed, /^- plan\.md$/m);
  assert.match(diffed, /^- docs\/b\.md$/m);
  assert.match(diffed, /^\+b$/m);
  assert.match(diffed, /changes since the last round/);
  assert.match(diffed, /^- plan\.md:4: em dash in prose$/m);
  const full = brief({ files: ['plan.md'], scope: 'full', known: [] });
  assert.match(full, /full text of every file/);
  assert.doesNotMatch(full, /changes since the last round/);
  assert.doesNotMatch(full, /already reported/);
});

test('the correction prompt lists blockers and non-blocking findings with what to do for each', () => {
  const prompt = correctionPrompt({
    findings: [finding(3, true), finding(8, false)],
  });

  assert.match(
    prompt,
    /Apply every one:\n- plan\.md:3: summary 3\n {2}Correction: correction 3/,
  );

  assert.match(
    prompt,
    /search open and closed issues[^\n]*\n- plan\.md:8: summary 8/,
  );

  assert.doesNotMatch(prompt, /--familiar-/);

  assert.match(
    correctionPrompt({
      failures: [{ file: 'plan.md', line: 2, message: 'em dash in prose' }],
    }),
    /^- plan\.md:2: em dash in prose$/m,
  );
});
