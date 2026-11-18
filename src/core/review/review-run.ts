import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { unlessGone } from '../../persistence/json.js';
import type { SessionCoordination } from '../coordination/coordination.js';
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
import type { Routed } from '../runtime/routing.js';
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

/** `/review`'s rounds as one operation; true once they settle or stop at a regression and the operation settles cleanly. */
export async function runReviewCommand(
  argument: string,
  host: ReviewHost,
): Promise<boolean> {
  let outcome: ReviewOutcome | undefined;

  await host.operate(async () => {
    outcome = await runReview(argument, host);
  });

  if (!outcome?.ok || host.signal.aborted || !host.idle()) return false;

  const { stop, nonBlocking, remaining, directory } = outcome;

  host.notice(
    `Review finished: ${stop} · ${nonBlocking} non-blocking findings sent · ${remaining} mechanical failures remain · reports in ${directory}`,
  );

  return true;
}

/** runs review rounds over the files `argument` names until they settle or stop; undefined when it refuses to start: no router, no files, a name that isn't a file in the directory, or one that holds a line break. */
async function runReview(
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

  const files: string[] = [];

  for (const file of named) {
    // file completion inserts `@path`
    const path = resolve(cwd, file.replace(/^@/, ''));
    const inside = relative(cwd, path);
    const exists = (await unlessGone(stat(path)))?.isFile() ?? false;

    if (
      !inside ||
      inside === '..' ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside) ||
      !exists
    ) {
      host.notice(`Review refused: ${file} is not a file in ${cwd}`);

      return;
    }

    // the brief and the correction prompt list targets one per line
    if (/[\n\r]/.test(inside)) {
      host.notice(
        `Review refused: ${JSON.stringify(inside)} has a line break in its name`,
      );

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
    let texts = await read();
    let failures = await checkTargets(cwd, files);

    // a second pass sends failures the first correction introduced
    for (let pass = 0; pass < 2; pass++) {
      const seen = identities(failures, texts);
      const fresh = failures.filter((_, index) => !sent.has(seen[index]!));

      if (!fresh.length) break;

      for (const identity of identities(fresh, texts)) sent.add(identity);

      if (!(await host.turn(correctionPrompt({ failures: fresh }))))
        return stopped(incomplete);

      texts = await read();
      failures = await checkTargets(cwd, files);
    }

    known = failures;
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
        known: reported,
      }),
    );

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

    const results = await host.reviewers.run({ cwd, reviewers, signal });

    if (signal.aborted) return stopped(incomplete);

    const reviews: Review[] = [];
    const failed: string[] = [];

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
        failed.push(
          `${name} ${reason}${result.diagnostics ? `: ${result.diagnostics}` : ''} · report ${reportFile}`,
        );
      else reviews.push({ runtime: route.runtime, findings });
    }

    if (failed.length) return stopped(failed.join('; '));

    if (!same(await read(), texts))
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
      findings.length ? (await checkTargets(cwd, files)).length : known.length;

    if ('stop' in decided)
      return outcome(decided.stop, true, await remaining());

    const after = afterCorrection({
      round,
      blockers: decided.blockers.length,
      sittingOut: decided.sittingOut,
      ...(decided.stopAfter ? { stopAfter: decided.stopAfter } : {}),
      changedDuring: !same(corrected, texts),
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
