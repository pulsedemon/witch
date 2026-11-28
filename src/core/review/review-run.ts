import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { errorMessage } from '../../errors.js';
import { gone } from '../../persistence/json.js';
import type { SessionCoordination } from '../coordination/coordination.js';
import {
  insideDirectory,
  openReviewFile,
  ReviewInputError,
  snapshotTargets,
  withTargetSnapshots,
} from './review-files.js';
import {
  afterCorrection,
  brief,
  changes,
  correctionPrompt,
  decide,
  parseFindings,
  reviewerCommand,
  scopeFor,
} from './review.js';
import type { Finding, Review, SitOut, Texts } from './review.js';
import { checkTargets, reviewRoot } from './review-checks.js';
import type { CheckFailure } from './review-checks.js';
import type { Reviewer, ReviewerResult, Reviewers } from './reviewers.js';
import type { Routed } from '../runtime/routing.js';
import { agentLabel } from '../snapshot.js';
import { untitled } from '../state.js';
import type { ConversationRecord, DisplayUpdate } from '../state.js';

/** what a review needs from the coordinator. */
interface ReviewHost {
  conversation: ConversationRecord;
  coordination:
    Pick<SessionCoordination, 'router' | 'commandPrefixes'> | undefined;
  reviewers: Pick<Reviewers, 'run'>;
  agents: readonly { id: string; label: string }[];
  signal: AbortSignal;
  notice(text: string): void;

  display(update: DisplayUpdate): void;

  /** keeps context for the agent's next turn. */
  retain(text: string): void;

  /** runs a silent correction turn; false when it or its memory publication didn't settle. */
  turn(prompt: string): Promise<boolean>;

  /** runs the rounds as one operation in the running phase. */
  operate(rounds: () => Promise<void>): Promise<void>;

  /** whether the operation settled without an error and left Witch idle. */
  idle(): boolean;
}

interface ReviewOutcome {
  stop: string;
  /** true for a settled review or a regression stop. */
  ok: boolean;
  /** the non-blocking findings correction turns received over the whole review. */
  nonBlocking: number;
  /** the mechanical failures at the last check. */
  remaining: number;
  directory: string;
}

function isReviewAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason ||
      (error instanceof Error && error.cause === signal.reason))
  );
}

/** `/review`'s rounds as one operation; true once they settle or stop at a regression and the operation settles cleanly. */
export async function runReviewCommand(
  argument: string,
  host: ReviewHost,
): Promise<boolean> {
  let outcome: ReviewOutcome | undefined;

  await host.operate(async () => {
    outcome = await runReview(argument, host).catch((error: unknown) => {
      if (!isReviewAbort(error, host.signal)) throw error;

      return undefined;
    });
  });

  if (!outcome?.ok || host.signal.aborted || !host.idle()) return false;

  const { stop, nonBlocking, remaining, directory } = outcome;

  host.notice(
    `Review finished: ${stop} · ${nonBlocking} non-blocking findings sent · ${remaining} mechanical failures remain · reports in ${directory}`,
  );

  return true;
}

async function reviewTargets(
  named: readonly string[],
  cwd: string,
  roots: readonly string[],
  signal: AbortSignal,
): Promise<string[] | { refused: string }> {
  const files: string[] = [];

  for (const file of named) {
    signal.throwIfAborted();
    // file completion inserts `@path`
    const path = resolve(cwd, file.replace(/^@/, ''));
    const inside = relative(cwd, path);

    if (!insideDirectory(cwd, path))
      return { refused: `Review refused: ${file} is not a file in ${cwd}` };

    // the brief and the correction prompt list targets one per line
    if (/[\n\r]/.test(inside))
      return {
        refused: `Review refused: ${JSON.stringify(inside)} has a line break in its name`,
      };

    try {
      const opened = await openReviewFile(path, roots);
      await opened.file.close();
    } catch (error) {
      if (!gone(error) && !(error instanceof ReviewInputError)) throw error;

      return {
        refused: `Review refused: ${file} is not a file in ${cwd}. ${errorMessage(error)}`,
      };
    }

    files.push(inside);
  }

  return files;
}

function reviewerFailure(
  result: ReviewerResult,
  route: Routed,
  findings: Finding[] | { invalid: string },
): string | undefined {
  if (result.status !== 'completed')
    return result.status
      ? `ended ${result.status}`
      : 'ended without registering';

  if (result.code !== 0) return `exited with code ${result.code}`;

  if (result.model !== route.model)
    return `ran on ${result.model ?? 'an unreported model'}, not ${route.model}`;

  if ('invalid' in findings)
    return `did not report findings: ${findings.invalid}`;

  return undefined;
}

/** runs review rounds over the files `argument` names until they settle or stop; undefined when it refuses to start: no router, no files, a name that isn't a file in the directory, or one that holds a line break. */
async function runReview(
  argument: string,
  host: ReviewHost,
): Promise<ReviewOutcome | undefined> {
  const { conversation, coordination, signal } = host;
  const { cwd } = conversation;
  const router = coordination?.router;

  if (!coordination || !router) {
    host.notice('This Witch cannot route work.');

    return;
  }

  // quotes or a backslash keep a space inside one name
  const named = [
    ...argument.matchAll(/(?:[^\s"'\\]|\\[^]|"[^"]*"|'[^']*')+/g),
  ].map(([name]) =>
    name.replace(
      /\\([^])|"([^"]*)"|'([^']*)'/g,
      (_, escaped?: string, double?: string, single?: string) =>
        escaped ?? double ?? single!,
    ),
  );

  if (!named.length) {
    host.notice('Use /review <files>.');

    return;
  }

  const root = await realpath(await reviewRoot(cwd, signal));
  const roots = [root];
  const files = await reviewTargets(named, cwd, roots, signal);

  if ('refused' in files) {
    host.notice(files.refused);

    return;
  }

  if (conversation.title === untitled)
    conversation.title = `Review ${files.join(' ')}`.slice(0, 80);

  host.display({
    id: randomUUID(),
    kind: 'user',
    text: `/review ${argument}`,
    cwd,
  });

  const model = conversation.sessions[conversation.agent]?.model;

  const action = {
    kind: 'route' as const,
    work: 'review' as const,
    ...(model ? { of: { runtime: conversation.agent, model } } : {}),
  };

  const directory = await mkdtemp(join(tmpdir(), 'review-'));
  const run = randomBytes(4).toString('hex');
  const read = () => snapshotTargets(cwd, files, roots, signal);

  const check = (snapshot: Awaited<ReturnType<typeof read>>) =>
    checkTargets(cwd, snapshot, { root, signal });

  const same = (a: Texts, b: Texts) =>
    files.every((file) => a[file] === b[file]);

  const identities = (failures: CheckFailure[], texts: Texts) => {
    const lines = new Map(
      files.map((file) => [file, texts[file]!.split('\n')]),
    );

    return failures.map(
      (failure) =>
        `${failure.file}\0${failure.message}\0${lines.get(failure.file)?.[failure.line - 1] ?? ''}`,
    );
  };

  let known: CheckFailure[] = [];
  /** the failures a correction turn received, so each gets one attempt. */
  let sent = new Set<string>();
  let reviewed: Texts | undefined;
  let next = { number: 1, closing: false };
  let sittingOut: SitOut[] = [];
  let nonBlocking = 0;

  const outcome = (
    stop: string,
    ok: boolean,
    remaining = known.length,
  ): ReviewOutcome => {
    host.retain(`Witch ran /review ${argument}: ${stop}`);

    return { stop, ok, nonBlocking, remaining, directory };
  };

  const stopped = (reason: string): ReviewOutcome => {
    if (!signal.aborted) host.notice(`Review stopped: ${reason}`);

    return outcome(reason, false);
  };

  for (;;) {
    const number = next.number;
    const incomplete = `round ${number} did not complete`;
    let snapshot = await read();
    let failures = await check(snapshot);

    // a second pass sends failures the first correction introduced
    for (let pass = 0; pass < 2; pass++) {
      const seen = identities(failures, snapshot.texts);
      const unsent = seen.filter((identity) => !sent.has(identity));
      const fresh = failures.filter((_, index) => !sent.has(seen[index]!));

      if (!fresh.length) break;

      for (const identity of unsent) sent.add(identity);

      if (!(await host.turn(correctionPrompt({ failures: fresh }))))
        return stopped(incomplete);

      snapshot = await read();
      failures = await check(snapshot);
    }

    known = failures;
    const { texts } = snapshot;
    const current = identities(failures, texts);
    sent = new Set(current.filter((identity) => sent.has(identity)));
    const reported = failures.filter((_, index) => sent.has(current[index]!));
    const delta = reviewed ? changes(reviewed, texts) : undefined;
    const scope = scopeFor(next, delta?.ratio ?? 0);

    if (signal.aborted) return stopped(incomplete);

    const cancelled = Promise.withResolvers<undefined>();
    const cancel = () => cancelled.resolve(undefined);
    signal.addEventListener('abort', cancel, { once: true });

    const reply = await Promise.race([
      router(action, signal),
      cancelled.promise,
    ]).finally(() => signal.removeEventListener('abort', cancel));

    if (!reply || signal.aborted) return stopped(incomplete);

    if (reply.kind === 'error') return stopped(reply.message);

    if (reply.kind !== 'route') return stopped('unexpected route reply');

    const out = new Set(sittingOut.map(({ runtime }) => runtime));

    let routes: Routed[] = reply.routes.filter(
      ({ runtime }) => !out.has(runtime),
    );

    if (!routes.length) routes = reply.routes;

    if (!routes.length) return stopped('no reviewer was routed');

    // read before any notice, whose listeners can close Witch and make the lookup throw; a correction that reconnects gets a new prefix
    const prefix = coordination.commandPrefixes().familiar;

    const dropped = sittingOut.filter(
      ({ runtime }) =>
        reply.routes.some((route) => route.runtime === runtime) &&
        !routes.some((route) => route.runtime === runtime),
    );

    host.notice(
      `Review round ${number} · ${scope}: ${routes
        .map(
          ({ runtime, model }) =>
            `${agentLabel(host.agents, runtime)} · ${model}`,
        )
        .join(', ')}${dropped
        .map(
          ({ runtime, why }) =>
            `; ${agentLabel(host.agents, runtime)} sits out: ${why}`,
        )
        .join('')}`,
    );

    const briefFile = join(directory, `round-${number}-brief.md`);

    const reviewers: (Reviewer & { route: Routed })[] = routes.map((route) => {
      const name = `review-${run}-${number}-${route.runtime}`;
      const reportFile = join(directory, `${name}.md`);

      return {
        name,
        route,
        reportFile,
        command: reviewerCommand({
          prefix,
          route,
          name,
          reportFile,
          briefFile,
        }),
      };
    });

    const results = await withTargetSnapshots(
      directory,
      texts,
      async (snapshots) => {
        await writeFile(
          briefFile,
          brief({
            snapshots,
            scope,
            ...(scope === 'diff' && delta ? { diff: delta.diff } : {}),
            known: reported,
          }),
          { signal },
        );

        signal.throwIfAborted();

        return host.reviewers.run({ cwd, reviewers, signal });
      },
      signal,
    ).catch((error: unknown) => {
      if (isReviewAbort(error, signal)) return undefined;

      throw error;
    });

    if (!results || signal.aborted) return stopped(incomplete);

    const reviews: Review[] = [];
    const failed: string[] = [];

    for (const [index, result] of results.entries()) {
      const { route, name, reportFile } = reviewers[index]!;
      const findings = parseFindings(result.report, cwd, files);
      const reason = reviewerFailure(result, route, findings);

      if (reason || 'invalid' in findings)
        failed.push(
          `${name} ${reason}${result.diagnostics ? `: ${result.diagnostics}` : ''} · report ${reportFile}`,
        );
      else reviews.push({ runtime: route.runtime, findings });
    }

    if (failed.length) return stopped(failed.join('; '));

    if (!same((await read()).texts, texts))
      return stopped('the targets changed while reviewers read them');

    const round = {
      number,
      scope,
      runtimes: routes.map(({ runtime }) => runtime),
    };

    const decided = decide({
      round,
      reviews,
      ...(delta ? { previousChanges: delta.changed } : {}),
    });

    const findings: Finding[] = reviews.flatMap(({ findings }) => findings);

    if (findings.length && !(await host.turn(correctionPrompt({ findings }))))
      return stopped(incomplete);

    nonBlocking += findings.filter(({ blocking }) => !blocking).length;
    // read before settling, so a correction that removed a target fails the review
    const corrected = await read();

    const remaining = async () =>
      findings.length ? (await check(corrected)).length : known.length;

    if ('stop' in decided)
      return outcome(decided.stop, true, await remaining());

    const after = afterCorrection({
      round,
      blockers: decided.blockers.length,
      sittingOut: decided.sittingOut,
      ...(decided.stopAfter ? { stopAfter: decided.stopAfter } : {}),
      changedDuring: !same(corrected.texts, texts),
    });

    if ('stop' in after) {
      if (!after.ok) return stopped(after.stop);

      return outcome(after.stop, true, await remaining());
    }

    reviewed = texts;
    next = after.next;
    sittingOut = after.sittingOut;
  }
}
