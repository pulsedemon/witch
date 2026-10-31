import { errorMessage } from '../agents/stderr.js';
import { isCopilot, readGitHubReviews } from './github-reviews.js';
import type { GitHubReviews } from './github-reviews.js';
import type { PullRequest } from './repository.js';
import type { RepositoryWatch } from './repository.js';
import type { Coordinator } from './coordinator.js';

export class CopilotReviewWatch {
  private pr?: PullRequest;
  private generation = 0;
  private timer?: NodeJS.Timeout;
  private running?: AbortController;
  private requested = false;
  private closed = false;
  private active = false;
  private failure?: string;
  private completed = new Set<number>();

  constructor(
    private readonly cwd: string,
    private readonly receive: (source: GitHubReviews) => Promise<boolean>,
    private readonly notice: (text: string) => void,
    private readonly read = readGitHubReviews,
  ) {}

  update(pr: PullRequest | undefined): void {
    if (this.closed) return;
    if (pr?.state !== 'OPEN') pr = undefined;
    if (
      pr?.url === this.pr?.url &&
      pr?.commit === this.pr?.commit &&
      pr?.branch === this.pr?.branch
    )
      return;
    if (pr?.url !== this.pr?.url) this.completed.clear();
    this.pr = pr;
    this.generation++;
    this.running?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active = false;
    this.failure = undefined;
    this.requested = !!pr;
    if (pr) this.refresh();
  }

  refresh(): void {
    if (this.closed || !this.pr) return;
    this.requested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) void this.poll();
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.requested = false;
    this.running?.abort();
    if (this.timer) clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    const pr = this.pr;
    if (!pr || this.closed || this.running) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.running = abort;
    this.requested = false;
    const current = () =>
      !this.closed && this.generation === generation && !abort.signal.aborted;
    try {
      const source = await this.read(pr, this.cwd, abort.signal);
      if (!current()) return;
      const pending = await this.receive(source);
      if (!current()) return;
      if (this.failure)
        this.notice(`Copilot review watching resumed for #${pr.number}.`);
      this.failure = undefined;
      const checks = source.checks.filter(
        ({ name }) => name === 'copilot-pull-request-reviewer',
      );
      this.active =
        pending ||
        source.requested.some(({ requestedReviewer }) =>
          isCopilot(requestedReviewer),
        ) ||
        checks.some(({ status }) => status !== 'completed');
      for (const check of checks) {
        if (check.status !== 'completed' || this.completed.has(check.id))
          continue;
        this.completed.add(check.id);
        this.requested = true;
      }
      if (source.pullRequest.state !== 'OPEN') {
        this.pr = undefined;
        this.requested = false;
      }
    } catch (error) {
      if (current()) {
        const failure = errorMessage(error);
        if (failure !== this.failure)
          this.notice(
            `Copilot review watch could not read #${pr.number}: ${failure}`,
          );
        this.failure = failure;
      }
    } finally {
      this.running = undefined;
      if (!this.closed && this.pr) {
        if (this.requested) this.refresh();
        else {
          this.timer = setTimeout(
            () => this.refresh(),
            this.active ? 30_000 : 90_000,
          );
          this.timer.unref();
        }
      }
    }
  }
}

export function watchCopilotReviews(
  repository: Pick<
    RepositoryWatch,
    'snapshot' | 'subscribe' | 'refreshPullRequest'
  >,
  coordinator: Pick<
    Coordinator,
    'snapshot' | 'subscribe' | 'coordination' | 'copilot' | 'notice'
  >,
  cwd: string,
): () => void {
  const watch = new CopilotReviewWatch(
    cwd,
    (source) => coordinator.copilot.observe(source),
    (text) => {
      if (
        coordinator.snapshot.conversation &&
        coordinator.snapshot.phase !== 'closing'
      )
        coordinator.notice(text);
    },
  );
  const update = () => {
    coordinator.copilot.updateRepository(repository.snapshot);
    const status = repository.snapshot;
    watch.update(
      status?.branch === status?.pullRequest?.branch
        ? status?.pullRequest
        : undefined,
    );
  };
  let reviewing = false;
  let conversation: string | undefined;
  let claim = '';
  const owner = () => {
    const current = coordinator.coordination?.snapshot.ownClaim;
    const key = JSON.stringify([
      current?.id,
      current?.references,
      !!current?.suggestion,
    ]);
    if (key !== claim) {
      claim = key;
      repository.refreshPullRequest();
      watch.refresh();
    }
  };
  const stops = [
    repository.subscribe(update),
    coordinator.subscribe(() => {
      const next = coordinator.snapshot.conversation?.id;
      if (
        next !== conversation ||
        (reviewing && !coordinator.snapshot.reviewing)
      )
        watch.refresh();
      conversation = next;
      reviewing = !!coordinator.snapshot.reviewing;
    }),
    ...(coordinator.coordination
      ? [coordinator.coordination.subscribe(owner)]
      : []),
  ];
  update();
  owner();
  return () => {
    for (const stop of stops) stop();
    watch.close();
  };
}
