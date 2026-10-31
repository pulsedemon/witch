import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SessionCoordination } from './coordination.js';
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
import { checkTargets } from './review-checks.js';
import type { CheckFailure } from './review-checks.js';
import type { Reviewer, Reviewers } from './reviewers.js';
import type { Routed } from './routing.js';
import { untitled } from './state.js';
import type { ConversationRecord, DisplayUpdate } from './state.js';

/** what a review needs from the coordinator, which runs it as one operation. */
export interface ReviewHost {
  conversation: ConversationRecord;
  coordination:
    Pick<SessionCoordination, 'router' | 'commandPrefixes'> | undefined;
  reviewers: Pick<Reviewers, 'run'>;
  agents: readonly { id: string; label: string }[];
  signal: AbortSignal;
  notice(text: string): void;
  display(update: DisplayUpdate): void;
  /** runs a silent correction turn; false when it or its memory publication didn't settle. */
  turn(prompt: string): Promise<boolean>;
}

export interface ReviewOutcome {
  stop: string;
  /** true for a settled review or a regression stop. */
  ok: boolean;
  /** the non-blocking findings correction turns received over the whole review. */
  nonBlocking: number;
  /** the mechanical failures at the last check. */
  remaining: number;
  directory: string;
}

/** the finish notice for a review that settled or stopped at a regression. */
export function finished(outcome: ReviewOutcome): string {
  return `Review finished: ${outcome.stop} · ${outcome.nonBlocking} non-blocking findings sent · ${outcome.remaining} mechanical failures remain · reports in ${outcome.directory}`;
}

/** runs review rounds over the files `argument` names until they settle or stop; undefined when it refuses to start: no router, no files, or a name that isn't a file in the directory. */
export async function runReview(
  argument: string,
  host: ReviewHost,
): Promise<ReviewOutcome | undefined> {
  const { conversation, coordination, signal } = host;
  const { cwd } = conversation;
  const label = (runtime: string) =>
    host.agents.find(({ id }) => id === runtime)?.label ?? runtime;
  const router = coordination?.router;
  if (!coordination || !router) {
    host.notice('This Witch cannot route work.');
    return;
  }
  const named = argument.split(/\s+/).filter(Boolean);
  if (!named.length) {
    host.notice('Use /review <files>.');
    return;
  }
  const files: string[] = [];
  for (const file of named) {
    // file completion inserts `@path`
    const path = resolve(cwd, file.replace(/^@/, ''));
    const inside = relative(cwd, path);
    const exists = await stat(path).then(
      (entry) => entry.isFile(),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      },
    );
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !exists) {
      host.notice(`Review refused: ${file} is not a file in ${cwd}`);
      return;
    }
    files.push(inside);
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
  const read = async (): Promise<Texts> =>
    Object.fromEntries(
      await Promise.all(
        files.map(
          async (file) =>
            [file, await readFile(resolve(cwd, file), 'utf8')] as const,
        ),
      ),
    );
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
  let knownIdentities = new Set<string>();
  let reviewed: Texts | undefined;
  let next = { number: 1, closing: false };
  let sittingOut: SitOut[] = [];
  let nonBlocking = 0;
  const outcome = (
    stop: string,
    ok: boolean,
    remaining = known.length,
  ): ReviewOutcome => ({ stop, ok, nonBlocking, remaining, directory });
  const stopped = (reason: string): ReviewOutcome => {
    if (!signal.aborted) host.notice(`Review stopped: ${reason}`);
    return outcome(reason, false);
  };
  for (;;) {
    const number = next.number;
    const incomplete = `round ${number} did not complete`;
    let texts = await read();
    let failures = await checkTargets(cwd, files);
    const seen = identities(failures, texts);
    const fresh = failures.filter(
      (_, index) => !knownIdentities.has(seen[index]!),
    );
    if (fresh.length) {
      if (!(await host.turn(correctionPrompt({ failures: fresh }))))
        return stopped(incomplete);
      texts = await read();
      failures = await checkTargets(cwd, files);
    }
    known = failures;
    knownIdentities = new Set(identities(failures, texts));
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
    const dropped = sittingOut.filter(
      ({ runtime }) =>
        reply.routes.some((route) => route.runtime === runtime) &&
        !routes.some((route) => route.runtime === runtime),
    );
    host.notice(
      `Review round ${number} · ${scope}: ${routes
        .map(({ runtime, model }) => `${label(runtime)} · ${model}`)
        .join(', ')}${dropped
        .map(({ runtime, why }) => `; ${label(runtime)} sits out: ${why}`)
        .join('')}`,
    );
    const briefFile = join(directory, `round-${number}-brief.md`);
    await writeFile(
      briefFile,
      brief({
        files,
        scope,
        ...(scope === 'diff' && delta ? { diff: delta.diff } : {}),
        known,
      }),
    );
    // a correction that reconnects the session activates coordination anew, with a new familiar prefix
    const prefix = coordination.commandPrefixes().familiar;
    const counts = new Map<string, number>();
    const reviewers: (Reviewer & { route: Routed })[] = routes.map((route) => {
      const index = counts.get(route.runtime) ?? 0;
      counts.set(route.runtime, index + 1);
      const name = `review-${run}-${number}-${route.runtime}-${index}`;
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
    if (signal.aborted) return stopped(incomplete);
    const results = await host.reviewers.run({ cwd, reviewers, signal });
    if (signal.aborted) return stopped(incomplete);
    const reviews: Review[] = [];
    for (const [index, result] of results.entries()) {
      const { route, name, reportFile } = reviewers[index]!;
      const findings = parseFindings(result.report, cwd, files);
      const reason =
        result.status !== 'completed'
          ? result.status
            ? `ended ${result.status}`
            : 'ended without registering'
          : result.code !== 0
            ? `exited with code ${result.code}`
            : result.model !== route.model
              ? `ran on ${result.model ?? 'an unreported model'}, not ${route.model}`
              : 'invalid' in findings
                ? `did not report findings: ${findings.invalid}`
                : undefined;
      if (reason || 'invalid' in findings)
        return stopped(
          `${name} ${reason}${result.diagnostics ? `: ${result.diagnostics}` : ''} · report ${reportFile}`,
        );
      reviews.push({ runtime: route.runtime, findings });
    }
    if (!same(await read(), texts))
      return stopped('the targets changed while reviewers read them');
    const round = {
      number,
      scope,
      runtimes: [...new Set(routes.map(({ runtime }) => runtime))],
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
    const remaining = async () =>
      findings.length ? (await checkTargets(cwd, files)).length : known.length;
    if ('stop' in decided)
      return outcome(decided.stop, true, await remaining());
    const after = afterCorrection({
      round,
      blockers: decided.blockers.length,
      sittingOut: decided.sittingOut,
      ...(decided.stopAfter ? { stopAfter: decided.stopAfter } : {}),
      changedDuring: !same(await read(), texts),
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
