import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from '../agents/stderr.js';
import type { TurnResult } from '../agents/types.js';
import { readJson } from '../persistence/json.js';
import {
  blockReviewBatch,
  observeReviews,
  reconcileReviews,
  reviewResultSchema,
} from './copilot-reviews.js';
import type { CopilotReviewState, ReviewBatch } from './copilot-reviews.js';
import { readGitHubReviews, reviewCommitPushed } from './github-reviews.js';
import type { GitHubReviews } from './github-reviews.js';
import type { SessionCoordination } from './coordination.js';
import type { Repository } from './repository.js';
import type { Snapshot } from './snapshot.js';
import type { ConversationRecord } from './state.js';

interface ReviewHost {
  record(): ConversationRecord | undefined;
  snapshot(): Snapshot;
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
  private retry = false;
  private unmatched?: string;
  private noticeState?: string;
  private abort = new AbortController();

  constructor(
    private readonly host: ReviewHost,
    private readonly read = readGitHubReviews,
    private readonly pushed = reviewCommitPushed,
  ) {}

  activate(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.source = undefined;
    this.sourceOwner = undefined;
    this.retry = false;
    this.unmatched = undefined;
    this.noticeState = undefined;
    this.revoked = undefined;
  }

  updateRepository(repository: Repository | undefined): void {
    this.repository = repository;
    this.checkBinding();
  }

  checkBinding(): void {
    const batch = this.executing;
    if (!batch || this.revoked === batch.id || this.abort.signal.aborted)
      return;
    const scope = this.host.coordination()?.snapshot;
    const record = this.host.record();
    const changed =
      record?.id !== batch.owner ||
      (this.repository &&
        (this.repository.branch !== batch.pullRequest.branch ||
          (this.repository.pullRequest &&
            (this.repository.pullRequest.url !== batch.pullRequest.url ||
              this.repository.pullRequest.state !== 'OPEN')))) ||
      (scope &&
        !scope.error &&
        (scope.ownClaim?.id !== batch.claim ||
          (scope.ownClaim &&
            scope.ownClaim.owner.project !==
              this.host.coordination()!.reviews.owner.project)));
    if (changed) {
      this.revoked = batch.id;
      this.host.notice(
        'Copilot review handling stopped because its branch or task ownership changed.',
      );
      void this.host
        .interrupt()
        .catch((error: unknown) => this.host.notice(errorMessage(error)));
    }
  }

  resume(): void {
    this.retry = true;
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
          this.pushed(source.pullRequest, commit, cwd, this.abort.signal),
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
        if (record.copilotReviews?.pullRequest.url === source.pullRequest.url) {
          record.copilotReviews.pullRequest = source.pullRequest;
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
      let state = observeReviews(record.copilotReviews, source);
      state.claim = bound.claim.id;
      state = await this.recover(state, source, record.cwd);
      if (!this.matches(record, source)) return false;
      record.copilotReviews = state;
      this.source = source;
      this.sourceOwner = record.id;
      await this.host.save();
      this.show(record);
      this.host.changed();
      return state.items.some(({ status }) => status !== 'handled');
    });
  }

  context(): CopilotReviewState | undefined {
    if (this.abort.signal.aborted) return;
    const state = this.host.record()?.copilotReviews;
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
    const state = this.context();
    return (
      !this.executing &&
      this.sourceOwner === record?.id &&
      !!state &&
      state.pullRequest.state === 'OPEN' &&
      !!state.claim &&
      this.host.coordination()?.snapshot.ownClaim?.id === state.claim &&
      state.items.some(
        ({ status }) =>
          status === 'pending' || (this.retry && status === 'blocked'),
      )
    );
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
      const fresh = await this.read(
        source.pullRequest,
        record.cwd,
        this.abort.signal,
      );
      await this.observe(fresh);
      if (!this.matches(record, fresh) || !this.host.ready() || !this.ready())
        return false;
      if (
        !(await coordination.reviews.owns(
          record.copilotReviews!.claim!,
          fresh.pullRequest,
        ))
      )
        return false;
      batch = await this.serial(async () => {
        if (!this.matches(record, fresh) || !this.host.ready()) return;
        const state = record.copilotReviews!;
        if (this.retry) {
          for (const item of state.items)
            if (item.status === 'blocked') item.status = 'pending';
          delete state.batch;
        }
        this.retry = false;
        if (state.batch) return;
        const items = state.items.filter(({ status }) => status === 'pending');
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
          for (const item of record.copilotReviews!.items)
            if (
              batch!.items.some(
                ({ id, version }) => id === item.id && version === item.version,
              )
            )
              item.status = 'pending';
          delete record.copilotReviews!.batch;
          await this.host.save();
        });
        return false;
      }
      this.executing = batch;
      const result = await this.host.run(batch);
      this.executing = undefined;
      if (this.host.record() !== record) return true;
      const after = await this.read(
        batch.pullRequest,
        record.cwd,
        this.abort.signal,
      );
      await this.serial(async () => {
        if (
          this.host.record() !== record ||
          record.copilotReviews?.pullRequest.url !== after.pullRequest.url
        )
          return;
        let state = observeReviews(record.copilotReviews, after);
        state = await this.recover(state, after, record.cwd);
        if (result?.status !== 'completed' && state.batch)
          state = blockReviewBatch(
            state,
            result?.error ??
              'Review handling was interrupted; its result must be reconciled before retrying.',
          );
        if (this.host.record() !== record) return;
        record.copilotReviews = state;
        this.source = after;
        await this.host.save();
        this.show(record);
      });
      return true;
    } catch (error) {
      if (this.host.record() === record) {
        await this.serial(async () => {
          if (this.host.record() !== record) return;
          if (batch && record.copilotReviews)
            record.copilotReviews = blockReviewBatch(
              record.copilotReviews,
              errorMessage(error),
            );
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
    const state = record.copilotReviews;
    if (!state) return;
    const handled = state.items.filter(
      ({ status }) => status === 'handled',
    ).length;
    const blocked = state.items.filter(({ status }) => status === 'blocked');
    const pending = state.items.length - handled - blocked.length;
    const signature = JSON.stringify([
      record.id,
      state.pullRequest.url,
      state.pullRequest.state,
      handled,
      pending,
      blocked.map(({ id, reason }) => [id, reason]),
    ]);
    if (signature === this.noticeState) return;
    this.noticeState = signature;
    this.host.notice(
      state.pullRequest.state !== 'OPEN'
        ? `Copilot review watching stopped: #${state.pullRequest.number} is ${state.pullRequest.state.toLowerCase()}.`
        : `Watching Copilot on #${state.pullRequest.number}: ${handled} handled, ${pending} pending, ${blocked.length} blocked.${
            blocked.length
              ? ` ${blocked
                  .map(({ reason }) => reason)
                  .filter(Boolean)
                  .join(' ')}`
              : ''
          }`,
    );
  }
}
