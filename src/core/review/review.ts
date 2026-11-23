import { isAbsolute, normalize, relative } from 'node:path';
import { formatPatch, structuredPatch } from 'diff';
import { z } from 'zod';
import { errorMessage, issuesText } from '../../errors.js';
import { quote } from '../../shell.js';
import type { CheckFailure } from './review-checks.js';
import type { Routed } from '../runtime/routing.js';

const findingsSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      file: z.string(),
      line: z.number().int().positive(),
      blocking: z.boolean(),
      summary: z.string(),
      correction: z.string(),
    }),
  ),
});

export type Finding = z.infer<typeof findingsSchema>['findings'][number];

/** the findings in a report's last fenced json block, with each file normalized to a listed target; `invalid` says why there are none to read. */
export function parseFindings(
  report: string,
  cwd: string,
  files: readonly string[],
): Finding[] | { invalid: string } {
  // a fence opens a line, indented at most three spaces, so a mention in prose isn't one
  const last = [
    ...report.matchAll(/^[ \t]{0,3}```json[^\n]*\n([\s\S]*?)\n\s*```/gm),
  ].at(-1);

  if (!last) return { invalid: 'no closed json block' };

  if (/^[ \t]{0,3}```json/m.test(report.slice(last.index + last[0].length)))
    return { invalid: 'a json block opens after the last closed one' };

  let parsed: unknown;

  try {
    parsed = JSON.parse(last[1]!);
  } catch (error) {
    return { invalid: errorMessage(error) };
  }

  const result = findingsSchema.safeParse(parsed);

  if (!result.success)
    return {
      invalid: issuesText(result.error),
    };

  const findings: Finding[] = [];

  for (const finding of result.data.findings) {
    const file = normalize(
      isAbsolute(finding.file) ? relative(cwd, finding.file) : finding.file,
    );

    if (!files.includes(file))
      return { invalid: `${finding.file} is not a review target` };

    findings.push({ ...finding, file });
  }

  return findings;
}

/** the targets' contents by cwd-relative path. */
export type Texts = Readonly<Record<string, string>>;

/** the diff between two snapshots, the after-side lines it added, and its added plus removed lines over the after side's length. */
export function changes(
  before: Texts,
  after: Texts,
): { diff: string; changed: Map<string, Set<number>>; ratio: number } {
  const patches = [];
  const changed = new Map<string, Set<number>>();
  let touched = 0;
  let total = 0;

  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const text = after[file] ?? '';
    total += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const patch = structuredPatch(file, file, before[file] ?? '', text);

    if (!patch.hunks.length) continue;

    patches.push(patch);
    const lines = new Set<number>();

    for (const hunk of patch.hunks) {
      let line = hunk.newStart;

      for (const row of hunk.lines) {
        if (row.startsWith('+')) {
          lines.add(line++);
          touched++;
        } else if (row.startsWith('-')) touched++;
        else if (row.startsWith(' ')) line++;
      }
    }

    if (lines.size) changed.set(file, lines);
  }

  return {
    diff: patches.length ? formatPatch(patches) : '',
    changed,
    ratio: total ? touched / total : touched ? Infinity : 0,
  };
}

type Scope = Round['scope'];

interface NextRound {
  number: number;
  closing: boolean;
}

export interface Round {
  number: number;
  scope: 'diff' | 'full';
  /** the runtimes whose reviewers ran, after sitting out was applied. */
  runtimes: readonly string[];
}

/** one reviewer's findings. */
export interface Review {
  runtime: string;
  findings: readonly Finding[];
}

export interface SitOut {
  runtime: string;
  why: string;
}

/** after a round's reviewers report: settle, or the blockers to correct and who sits out next. */
export function decide({
  round,
  reviews,
  previousChanges,
}: {
  round: Round;
  reviews: readonly Review[];
  previousChanges?: Map<string, Set<number>>;
}):
  | { stop: string }
  | { blockers: Finding[]; sittingOut: SitOut[]; stopAfter?: string } {
  const blockers = reviews.flatMap(({ findings }) =>
    findings.filter(({ blocking }) => blocking),
  );

  if (!blockers.length)
    return round.scope === 'full'
      ? {
          stop: `settled: round ${round.number} found no blockers in a full pass`,
        }
      : { blockers, sittingOut: [] };

  if (
    previousChanges &&
    blockers.every(({ file, line }) => previousChanges.get(file)?.has(line))
  )
    return {
      blockers,
      sittingOut: [],
      stopAfter: 'every blocker sat on lines corrected since the last round',
    };

  return {
    blockers,
    sittingOut: round.runtimes
      .filter((runtime) =>
        reviews
          .filter((review) => review.runtime === runtime)
          .every(({ findings }) => !findings.some(({ blocking }) => blocking)),
      )
      .map((runtime) => ({
        runtime,
        why: `its reviewers found no blockers in round ${round.number}`,
      })),
  };
}

/** after `decide` keeps going, once its findings, if any, reached the correction turn: stop, or the next round. */
export function afterCorrection({
  round,
  blockers,
  sittingOut,
  stopAfter,
  changedDuring,
}: {
  round: Round;
  blockers: number;
  sittingOut: readonly SitOut[];
  stopAfter?: string;
  changedDuring: boolean;
}): { stop: string; ok: boolean } | { next: NextRound; sittingOut: SitOut[] } {
  if (blockers && !changedDuring)
    return { stop: 'the blockers were not applied', ok: false };

  if (stopAfter) return { stop: stopAfter, ok: true };

  return blockers
    ? {
        next: { number: round.number + 1, closing: false },
        sittingOut: [...sittingOut],
      }
    : { next: { number: round.number + 1, closing: true }, sittingOut: [] };
}

/** round 1, a closing pass and a large diff review the full text. */
export function scopeFor(next: NextRound, ratio: number): Scope {
  return next.number === 1 || next.closing || ratio > 0.5 ? 'full' : 'diff';
}

function located({ file, line }: { file: string; line: number }): string {
  return `${file}:${line}`;
}

/** the turn that applies a round's findings, or fixes the mechanical failures before any reviewer reads the text. */
export function correctionPrompt(
  input:
    { findings: readonly Finding[] } | { failures: readonly CheckFailure[] },
): string {
  if ('failures' in input)
    return [
      'Witch review: fix these mechanical check failures in the review targets. Edit only the targets. Leave a proper noun in its own case even when a check flags it.',
      '',
      ...input.failures.map(
        (failure) => `- ${located(failure)}: ${failure.message}`,
      ),
      '',
      'Reply with one line per changed file.',
    ].join('\n');

  const item = (finding: Finding) =>
    `- ${located(finding)}: ${finding.summary}\n  Correction: ${finding.correction}`;

  const blockers = input.findings.filter(({ blocking }) => blocking);
  const others = input.findings.filter(({ blocking }) => !blocking);

  return [
    "Witch review: this round's reviewers reported the findings below. Edit only the review targets, and start no review of your own.",
    ...(blockers.length
      ? ['', 'Blocking. Apply every one:', ...blockers.map(item)]
      : []),
    ...(others.length
      ? [
          '',
          'Non-blocking. Fix each one whose change is small. For any other, search open and closed issues in this repository first and reuse a match; otherwise create one issue naming the target file and line, the finding and a checkable completion condition.',
          ...others.map(item),
        ]
      : []),
    '',
    'Reply with one line per changed file and one per issue reused or created.',
  ].join('\n');
}

/** what a reviewer reads on stdin. */
export function brief({
  files,
  scope,
  diff,
  known,
}: {
  files: readonly string[];
  scope: Scope;
  diff?: string;
  known: readonly CheckFailure[];
}): string {
  return [
    'You are reviewing these files for Witch. Read every one in full for context:',
    ...files.map((file) => `- ${file}`),
    '',
    scope === 'diff' && diff
      ? `Review the changes since the last round, below. Verify every changed passage completely and spot-check the rest.\n\n\`\`\`diff\n${diff}\`\`\``
      : 'Review the full text of every file.',
    '',
    'Mark a finding blocking only when the text would mislead or act wrongly. File a finding about cited code on the target line that cites it. Change no file.',
    ...(known.length
      ? [
          '',
          'These mechanical failures are already reported. Do not file them again:',
          ...known.map(
            (failure) => `- ${located(failure)}: ${failure.message}`,
          ),
        ]
      : []),
    '',
    'End your report with a fenced json block in exactly this shape, using the paths listed above:',
    '',
    '```json',
    '{"findings":[{"file":"path","line":1,"blocking":true,"summary":"what is wrong","correction":"the minimal fix"}]}',
    '```',
  ].join('\n');
}

/** the familiar wrapper command for one routed reviewer, read-only and lean: no MCP server or spell catalog, and no hooks on Claude. */
export function reviewerCommand({
  prefix,
  route,
  name,
  reportFile,
  briefFile,
}: {
  prefix: string;
  route: Routed;
  name: string;
  reportFile: string;
  briefFile: string;
}): string {
  const native =
    route.runtime === 'claude'
      ? [
          '--model',
          route.model,
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
        ]
      : [
          '-c',
          `model="${route.model}"`,
          '-c',
          'sandbox_mode="read-only"',
          '-c',
          'approval_policy="never"',
        ];

  return [
    prefix,
    `--familiar-${route.runtime}`,
    quote(name),
    '--report-file',
    quote(reportFile),
    '--lean',
    '--',
    ...native.map(quote),
    '<',
    quote(briefFile),
  ].join(' ');
}
