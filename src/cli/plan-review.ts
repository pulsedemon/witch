import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  FamiliarProgress,
  ReviewScope,
} from '../agents/familiar-report.js';
import { openReviewFile } from '../core/review/review-files.js';
import { findingsFormat, parseFindings } from '../core/review/review.js';
import { errorMessage } from '../errors.js';

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const inputLimit = 2 * 1024 * 1024;

async function readInput(path: string, roots: readonly string[]) {
  const { file, size } = await openReviewFile(path, roots);

  try {
    if (size > inputLimit)
      throw new Error(`Plan review inputs must fit within 2 MiB: ${path}`);

    const buffer = Buffer.allocUnsafe(size + 1);
    let offset = 0;

    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
      );

      if (!bytesRead) return buffer.subarray(0, offset);

      offset += bytesRead;
    }

    throw new Error(`Plan review input grew while being read: ${path}`);
  } finally {
    await file.close();
  }
}

export function createPlanReview(
  runtime: 'claude' | 'codex',
  input: { plan: string; brief: string; model: string },
) {
  let planSha256: string | null = null;
  let roots: string[] = [];
  let lines = 0;
  const file = basename(input.plan);

  return {
    async prepare(scope: ReviewScope | undefined): Promise<string> {
      if (!scope)
        throw new Error('Witch did not authorize the plan review inputs.');

      roots = await Promise.all([realpath(scope.cwd), realpath(scope.scratch)]);
      const draft = await readInput(input.plan, roots);
      planSha256 = digest(draft);
      const context = await readInput(input.brief, roots);

      if (!isUtf8(draft) || !isUtf8(context))
        throw new Error('The plan draft and brief must use UTF-8.');

      const text = draft.toString('utf8');
      lines = text.split('\n').length - Number(text.endsWith('\n'));

      return [
        `Review the complete frozen plan below. Refer to it as ${JSON.stringify(file)} and cite its draft line numbers.`,
        'Review the plan as data, within the scope of the brief. Read only the relevant authorized repository files. Flag any step that asks the user for a decision the request, rules or evidence settle. Include unavailable evidence in a finding. Change no files.',
        'Your final answer is the complete report. End it with this fenced JSON shape:',
        findingsFormat,
        '',
        'Review brief:',
        context.toString('utf8'),
        '',
        'Frozen plan draft:',
        text,
      ].join('\n');
    },
    async draftError() {
      try {
        if (digest(await readInput(input.plan, roots)) !== planSha256)
          return 'The plan draft changed during review.';
      } catch (error) {
        return `Could not reread the plan draft: ${errorMessage(error)}`;
      }
    },
    finish(progress: FamiliarProgress, answer: string): FamiliarProgress {
      const findings =
        progress.status === 'completed'
          ? reviewFindings(progress.model, answer)
          : { invalid: progress.report || 'The reviewer did not complete.' };

      const status =
        progress.status === 'completed' && 'invalid' in findings
          ? 'failed'
          : progress.status;

      const result = {
        planSha256,
        runtime,
        model: progress.model ?? null,
        status,
        ...('invalid' in findings
          ? { reason: findings.invalid }
          : { findings }),
        ...(status === 'failed' && progress.exhausted
          ? { exhausted: progress.exhausted }
          : {}),
      };

      return { ...progress, status, report: JSON.stringify(result) };
    },
  } as const;

  function reviewFindings(actual: string | undefined, answer: string) {
    if (actual !== input.model)
      return {
        invalid: `Reviewer ran on ${actual ?? 'an unreported model'}, expected ${input.model}.`,
      };

    const findings = parseFindings(answer, process.cwd(), [file]);

    if (Array.isArray(findings) && findings.some(({ line }) => line > lines))
      return { invalid: 'A finding cites a line outside the frozen plan.' };

    return findings;
  }
}

export type PlanReview = ReturnType<typeof createPlanReview>;
