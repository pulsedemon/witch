import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from '../errors.js';
import type { TurnResult } from '../agents/types.js';
import { readJson } from '../persistence/json.js';
import {
  blockReviewBatch,
  observeReviews,
  reconcileReviews,
  reviewResultSchema,
} from './copilot-reviews.js';
import type { CopilotReviewState, ReviewBatch } from './copilot-reviews.js';
import {
  copilotChecks,
  copilotRequested,
  isCopilot,
  readGitHubReviews,
  reviewCommitPushed,
} from './github-reviews.js';
import type { GitHubReviews } from './github-reviews.js';
import type { SessionCoordination } from './coordination.js';
import type { Repository } from './repository.js';
import { bindingChanged, revoke } from './review-ownership.js';
import type { ConversationRecord } from './state.js';

export interface ReviewWatch {
  state: CopilotReviewState;
  /** GitHub hasn't asked Copilot to review the open head a minute after Witch first saw it. */
  unrequested: boolean;
}

interface ReviewHost {
  record(): ConversationRecord | undefined;

  coordination(): SessionCoordination | undefined;

  ready(): boolean;

  save(): Promise<void>;

  notice(text: string): void;

  changed(): void;

  run(batch: ReviewBatch): Promise<TurnResult | undefined>;

  interrupt(): Promise<void>;
}

export class CopilotReviewController {
  private repository?: Repository;
  private source?: GitHubReviews;
  private sourceOwner?: string;
  private updating: Promise<unknown> = Promise.resolve();
  private executing?: ReviewBatch;
  private revoked?: string;
  private retry?: string;
  private unmatched?: string;
  private noticeState?: string;
  private head?: {
    url: string;
    commit: string;
    seen: number;
    unrequested: boolean;
  };
  private abort = new AbortController();

  constructor(private readonly host: ReviewHost) {}

  activate(): void {
    this.abort.abort();

    this.abort = new AbortController();
    this.source = undefined;
    this.sourceOwner = undefined;
    this.retry = undefined;
    this.unmatched = undefined;
    this.noticeState = undefined;
    this.revoked = undefined;
    this.head = undefined;
  }

  updateRepository(repository: Repository | undefined): void {
    this.repository = repository;

    this.checkBinding();
  }

  checkBinding(): void {
    const batch = this.executing;

    if (!batch || this.revoked === batch.id || this.abort.signal.aborted)
      return;

    if (
      bindingChanged(
        batch,
        this.host.record()?.id,
        this.repository,
        this.host.coordination(),
      )
    ) {
      this.revoked = batch.id;

      revoke(
        this.host,
        'Copilot review handling stopped because its branch or task ownership changed.',
      );
    }
  }

  resume(): void {
    this.retry = this.repository?.pullRequest?.url;
  }

  close(): void {
    this.abort.abort();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.updating.then(work);
    this.updating = result.catch(() => {});

    return result;
  }

  private matches(record: ConversationRecord, source: GitHubReviews): boolean {
    return (
      !this.abort.signal.aborted &&
      this.host.record() === record &&
      this.repository?.branch === source.pullRequest.branch &&
      this.repository.pullRequest?.url === source.pullRequest.url
    );
  }

  private state(
    record: ConversationRecord,
    url = this.repository?.pullRequest?.url,
  ) {
    return record.copilotReviews?.find(
      ({ pullRequest }) => pullRequest.url === url,
    );
  }

  private setState(
    record: ConversationRecord,
    state: CopilotReviewState,
  ): void {
    const history = (record.copilotReviews ??= []);

    const index = history.findIndex(
      ({ pullRequest }) => pullRequest.url === state.pullRequest.url,
    );

    if (index < 0) history.push(state);
    else history[index] = state;
  }

  private async recover(
    state: CopilotReviewState,
    source: GitHubReviews,
    cwd: string,
  ): Promise<CopilotReviewState> {
    const batch = state.batch;

    if (!batch || this.executing?.id === batch.id) return state;

    try {
      const result = await readJson(batch.result, reviewResultSchema);

      if (result)
        return await reconcileReviews(state, batch, result, source, (commit) =>
          reviewCommitPushed(
            source.pullRequest,
            commit,
            cwd,
            this.abort.signal,
          ),
        );

      return blockReviewBatch(
        state,
        'The previous review outcome is uncertain. Send a prompt to reconcile and resume it.',
      );
    } catch (error) {
      return blockReviewBatch(
        state,
        `Review result could not be verified: ${errorMessage(error)}`,
      );
    }
  }

  observe(source: GitHubReviews): Promise<boolean> {
    return this.serial(async () => {
      const record = this.host.record();

      if (!record || !this.matches(record, source) || !this.host.coordination())
        return false;

      if (source.pullRequest.state !== 'OPEN') {
        const state = this.state(record, source.pullRequest.url);

        if (state) {
          state.pullRequest = source.pullRequest;

          await this.host.save();

          if (this.executing) {
            this.revoked = this.executing.id;

            await this.host.interrupt();
          }

          this.show(record);
        }

        return false;
      }

      const bound = await this.host
        .coordination()!
        .reviews.bind(source.pullRequest, source.closingIssues);

      if (!this.matches(record, source)) return false;

      if (!bound) {
        if (this.unmatched !== source.pullRequest.url) {
          this.unmatched = source.pullRequest.url;

          this.host.notice(
            `Copilot review watching for #${source.pullRequest.number} needs a matching task claim before it can handle feedback.`,
          );
        }

        return false;
      }

      this.unmatched = undefined;

      if (bound.warning) this.host.notice(bound.warning);

      this.track(source);

      let state = observeReviews(
        this.state(record, source.pullRequest.url),
        source,
      );

      state.claim = bound.claim.id;
      state = await this.recover(state, source, record.cwd);

      if (!this.matches(record, source)) return false;

      this.setState(record, state);

      this.source = source;
      this.sourceOwner = record.id;

      await this.host.save();

      this.show(record);

      this.host.changed();

      return state.items.some(
        ({ present, status }) => present && status !== 'handled',
      );
    });
  }

  /** a base branch rule asks Copilot within seconds of an open, ready for review or covered push, unless the account's credits ran out. */
  private track(source: GitHubReviews): void {
    const { url, commit } = source.pullRequest;

    if (this.head?.url !== url || this.head.commit !== commit)
      this.head = { url, commit, seen: Date.now(), unrequested: false };

    const rules = source.copilotRules.filter(
      ({ review_draft_pull_requests }) =>
        !source.draft || review_draft_pull_requests,
    );

    const onPush = rules.some(({ review_on_push }) => review_on_push);

    this.head.unrequested =
      !!rules.length &&
      Date.now() - this.head.seen >= 60_000 &&
      !copilotRequested(source) &&
      !copilotChecks(source).length &&
      !source.reviews.some(
        ({ author, commit: reviewed }) =>
          isCopilot(author) && (!onPush || reviewed?.oid === commit),
      );
  }

  private unrequested(state: CopilotReviewState): boolean {
    return (
      !!this.head?.unrequested &&
      this.head.url === state.pullRequest.url &&
      this.head.commit === this.repository?.pullRequest?.commit
    );
  }

  context(): ReviewWatch | undefined {
    const state = this.current();

    return state && { state, unrequested: this.unrequested(state) };
  }

  private current(): CopilotReviewState | undefined {
    if (this.abort.signal.aborted) return;

    const record = this.host.record();
    const state = record && this.state(record);
    const coordination = this.host.coordination();
    const claim = coordination?.snapshot.ownClaim;

    return state &&
      claim?.id === state.claim &&
      claim?.owner.project === coordination?.reviews.owner.project &&
      this.repository?.branch === state.pullRequest.branch &&
      this.repository.pullRequest?.url === state.pullRequest.url
      ? state
      : undefined;
  }

  ready(): boolean {
    const record = this.host.record();
    const state = this.current();
    const retry = this.retry === state?.pullRequest.url;

    return (
      !this.executing &&
      this.sourceOwner === record?.id &&
      !!state &&
      state.pullRequest.state === 'OPEN' &&
      this.source?.pullRequest.url === state.pullRequest.url &&
      !!state.claim &&
      this.host.coordination()?.snapshot.ownClaim?.id === state.claim &&
      (!state.batch || (!state.batch.verifying && retry)) &&
      state.items.some(
        (item) =>
          item.present &&
          (item.status === 'pending' ||
            (retry &&
              state.batch?.items.some(
                ({ id, version }) => item.id === id && item.version === version,
              ))),
      )
    );
  }

  private resetBatch(state: CopilotReviewState): void {
    for (const item of state.items)
      if (
        state.batch?.items.some(
          ({ id, version }) => id === item.id && version === item.version,
        )
      ) {
        item.status = 'pending';

        delete item.reason;
      }

    delete state.batch;
  }

  async run(): Promise<boolean> {
    const record = this.host.record();
    const source = this.source;
    const coordination = this.host.coordination();

    if (
      !record ||
      !source ||
      !coordination ||
      !this.host.ready() ||
      !this.ready()
    )
      return false;

    let batch: ReviewBatch | undefined;

    try {
      const fresh = await readGitHubReviews(
        source.pullRequest,
        record.cwd,
        this.abort.signal,
      );

      await this.observe(fresh);

      if (!this.matches(record, fresh) || !this.host.ready() || !this.ready())
        return false;

      if (
        !(await coordination.reviews.owns(
          this.state(record, fresh.pullRequest.url)!.claim!,
          fresh.pullRequest,
        ))
      )
        return false;

      batch = await this.serial(async () => {
        if (
          this.source !== fresh ||
          !this.matches(record, fresh) ||
          !this.host.ready()
        )
          return;

        const state = this.state(record, fresh.pullRequest.url)!;

        if (this.retry === state.pullRequest.url) this.resetBatch(state);

        this.retry = undefined;

        if (state.batch) return;

        const items = state.items.filter(
          ({ present, status }) => present && status === 'pending',
        );

        if (!items.length) return;

        const id = randomUUID();

        const admitted: ReviewBatch = {
          id,
          claim: state.claim!,
          owner: record.id,
          pullRequest: fresh.pullRequest,
          items: items.map(({ id, version }) => ({ id, version })),
          packet: join(tmpdir(), `copilot-review-${id}.json`),
          result: join(tmpdir(), `copilot-review-${id}-result.json`),
        };

        await writeFile(
          admitted.packet,
          JSON.stringify({ batch: admitted, source: fresh }),
          { flag: 'wx', mode: 0o600 },
        );

        if (!this.matches(record, fresh) || !this.host.ready()) return;

        state.batch = admitted;

        for (const item of items) item.status = 'attempted';

        await this.host.save();

        return admitted;
      });

      if (!batch) return false;

      if (!this.matches(record, fresh) || !this.host.ready()) {
        await this.serial(async () => {
          if (this.host.record() !== record) return;

          this.resetBatch(this.state(record, batch!.pullRequest.url)!);

          await this.host.save();
        });

        return false;
      }

      this.executing = batch;
      const result = await this.host.run(batch);
      this.executing = undefined;

      if (this.host.record() !== record) return true;

      if (result?.inputUnsent) {
        await this.serial(async () => {
          if (this.host.record() !== record) return;

          this.resetBatch(this.state(record, batch!.pullRequest.url)!);

          await this.host.save();

          this.show(record);
        });

        return false;
      }

      const after = await readGitHubReviews(
        batch.pullRequest,
        record.cwd,
        this.abort.signal,
      );

      await this.serial(async () => {
        if (this.host.record() !== record) return;

        let state = observeReviews(
          this.state(record, after.pullRequest.url),
          after,
        );

        state = await this.recover(state, after, record.cwd);

        if (
          result?.status !== 'completed' &&
          state.batch &&
          !state.batch.reason
        )
          state = blockReviewBatch(
            state,
            result?.error ??
              'Review handling was interrupted; its result must be reconciled before retrying.',
          );

        if (this.host.record() !== record) return;

        this.setState(record, state);

        if (this.matches(record, after)) this.source = after;

        await this.host.save();

        this.show(record);
      });

      return true;
    } catch (error) {
      if (this.host.record() === record) {
        await this.serial(async () => {
          if (this.host.record() !== record) return;

          const state = batch && this.state(record, batch.pullRequest.url);

          if (state)
            this.setState(record, blockReviewBatch(state, errorMessage(error)));

          await this.host.save();

          this.host.notice(
            `Copilot review handling could not continue: ${errorMessage(error)}`,
          );
        });
      }

      return !!batch;
    } finally {
      this.executing = undefined;
    }
  }

  private show(record: ConversationRecord): void {
    const state = this.state(record);

    if (!state) return;

    const items = state.items.filter(({ present }) => present);
    const handled = items.filter(({ status }) => status === 'handled').length;
    const blocked = items.filter(({ status }) => status === 'blocked');
    const pending = items.length - handled - blocked.length;

    const reasons = [
      ...new Set(
        [
          this.unrequested(state) &&
            "GitHub hasn't asked Copilot to review the latest push, likely because the account's Copilot credits ran out.",
          state.batch?.verifying &&
            'Waiting for GitHub to verify the previous review replies. Send a prompt to reconcile the recorded result if that evidence stays missing.',
          state.batch?.reason,
          ...blocked.map(({ reason }) => reason),
        ].filter(Boolean),
      ),
    ];

    const signature = JSON.stringify([
      record.id,
      state.pullRequest.url,
      state.pullRequest.state,
      handled,
      pending,
      blocked.map(({ id }) => id),
      reasons,
    ]);

    if (signature === this.noticeState) return;

    this.noticeState = signature;

    this.host.notice(
      state.pullRequest.state !== 'OPEN'
        ? `Copilot review watching stopped: #${state.pullRequest.number} is ${state.pullRequest.state.toLowerCase()}.`
        : `Watching Copilot on #${state.pullRequest.number}: ${handled} handled, ${pending} pending, ${blocked.length} blocked.${
            reasons.length ? ` ${reasons.join(' ')}` : ''
          }`,
    );
  }
}
