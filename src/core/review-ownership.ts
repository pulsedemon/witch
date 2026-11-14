import { errorMessage } from '../errors.js';

import { runCommand } from './command.js';

import { taskReference } from './coordination-state.js';

import type {
  ClaimInput,
  ClaimOwner,
  CoordinationSnapshot,
  TaskClaim,
} from './coordination-state.js';

import { recordTaskAssignment } from './github-assignment.js';

import type { assignGitHubTask } from './github-assignment.js';

import type { Verify } from '../persistence/coordination.js';

import type { SessionCoordination } from './coordination.js';

import type { PullRequest, Repository } from './repository.js';

interface ReviewScope {
  owner: ClaimOwner;
  cwd: string;
  repository?: Repository;
}

interface ReviewOwnershipPort {
  observed(): boolean;

  context(project?: string): Promise<{ snapshot: CoordinationSnapshot }>;

  current(): ReviewScope;

  claim(
    owner: ClaimOwner,
    input: ClaimInput,
    deadline: number,
    verify: Verify,
  ): Promise<TaskClaim>;

  assign: typeof assignGitHubTask;
  record(
    id: string,
    references: string[],
    deadline: number,
  ): Promise<TaskClaim | undefined>;
}

/** what a Witch-started pull request turn was admitted for. */
export interface PullRequestBinding {
  owner: string;
  claim: string;
  pullRequest: PullRequest;
}

/** a missing repository or pull request read, or a coordination error, leaves the binding in place. */
export function bindingChanged(
  binding: PullRequestBinding,
  conversation: string | undefined,
  repository: Repository | undefined,
  coordination: SessionCoordination | undefined,
): boolean {
  const scope = coordination?.snapshot;

  return (
    conversation !== binding.owner ||
    (!!repository &&
      (repository.branch !== binding.pullRequest.branch ||
        (!!repository.pullRequest &&
          (repository.pullRequest.url !== binding.pullRequest.url ||
            repository.pullRequest.state !== 'OPEN')))) ||
    (!!scope &&
      coordination.reviews.observed &&
      !scope.error &&
      (scope.ownClaim?.id !== binding.claim ||
        (!!scope.ownClaim &&
          scope.ownClaim.owner.project !== coordination.reviews.owner.project)))
  );
}

/** posts why an automatic turn stopped and interrupts it, posting an interrupt failure too. */
export function revoke(
  host: {
    notice(text: string): void;

    interrupt(): Promise<void>;
  },
  text: string,
): void {
  host.notice(text);

  void host
    .interrupt()
    .catch((error: unknown) => host.notice(errorMessage(error)));
}

export class ReviewOwnership {
  constructor(private readonly port: ReviewOwnershipPort) {}

  get observed(): boolean {
    return this.port.observed();
  }

  get owner(): ClaimOwner {
    return this.port.current().owner;
  }

  private matches(scope: ReviewScope, pr: PullRequest): boolean {
    const current = this.port.current();

    return (
      pr.state === 'OPEN' &&
      current.owner.conversation === scope.owner.conversation &&
      current.owner.project === scope.owner.project &&
      current.repository?.pullRequestProject === scope.owner.project &&
      current.repository.branch === pr.branch &&
      current.repository.pullRequest?.url === pr.url &&
      current.repository.pullRequest.state === 'OPEN'
    );
  }

  private async inspect(pr: PullRequest, project?: string) {
    const { snapshot } = await this.port.context(project);

    if (snapshot.error) throw new Error(snapshot.error);

    const scope = this.port.current();

    const claim = snapshot.ownClaim;

    if (
      !claim ||
      claim.suggestion ||
      !this.matches(scope, pr) ||
      claim.owner.conversation !== scope.owner.conversation ||
      claim.owner.project !== scope.owner.project
    )
      return;

    const { stdout } = await runCommand(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { cwd: scope.cwd, timeout: 10_000 },
    );

    if (stdout.trim() !== pr.branch || !this.matches(scope, pr)) return;

    return { scope, claim };
  }

  /** `project` is the one the caller's turn just read, which saves reading it again. */
  async owns(id: string, pr: PullRequest, project?: string): Promise<boolean> {
    const found = await this.inspect(pr, project);

    return (
      !!found &&
      found.claim.id === id &&
      found.claim.references.includes(
        taskReference(pr.url, found.scope.owner.project),
      )
    );
  }

  async bind(
    pr: PullRequest,
    closingIssues: readonly string[],
  ): Promise<{ claim: TaskClaim; warning?: string } | undefined> {
    const found = await this.inspect(pr);

    if (!found) return;

    const { scope, claim } = found;

    const reference = taskReference(pr.url, scope.owner.project);

    if (claim.references.includes(reference)) return { claim };

    const alias = closingIssues.find((url) =>
      claim.references.includes(taskReference(url, scope.owner.project)),
    );

    if (!alias) return;

    const deadline = Date.now() + 30_000;

    const bound = await this.port.claim(
      scope.owner,
      {
        reference: pr.url,
        aliases: [alias],
        summary: claim.summary,
      },
      deadline,
      async (ledger) => {
        if (
          !this.matches(scope, pr) ||
          !ledger.claims.some(
            (current) =>
              current.id === claim.id &&
              current.summary === claim.summary &&
              !current.suggestion &&
              current.owner.conversation === scope.owner.conversation &&
              current.owner.project === scope.owner.project,
          )
        )
          throw new Error(
            'Pull request ownership changed before review admission.',
          );
      },
    );

    if (!this.matches(scope, pr)) return;

    return recordTaskAssignment(
      bound,
      scope.cwd,
      deadline,
      this.port.assign,
      this.port.record,
    );
  }
}
