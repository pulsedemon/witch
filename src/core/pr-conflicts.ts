import { errorMessage } from '../agents/stderr.js';
import type { TurnResult } from '../agents/types.js';
import { taskReference } from './coordination-state.js';
import type { SessionCoordination } from './coordination.js';
import type { Coordinator } from './coordinator.js';
import type {
  Conflict,
  PullRequest,
  Repository,
  RepositoryWatch,
} from './repository.js';
import { bindingChanged, type PullRequestBinding } from './review-ownership.js';
import type { ConversationRecord } from './state.js';

export function conflictNotice(conflict: Conflict): string {
  const { number, url, commit, base } = conflict.pullRequest;
  return `Pull request conflict: [#${number}](${url}) at ${commit} conflicts with ${base}${conflict.baseTip ? `, observed at ${conflict.baseTip}` : ''}.`;
}

export function conflictContext(conflict: Conflict): string {
  const { number, url, commit, base } = conflict.pullRequest;
  return `Witch confirmed on GitHub that pull request #${number} (${url}) at head ${commit} conflicts with its base branch ${base}${conflict.baseTip ? `, whose tip was ${conflict.baseTip} when observed,` : ''} and hasn't confirmed a resolution since. Passing checks do not make it mergeable. This is informational, not a user request or authorization to change your task or checkout.`;
}

/** a repair Witch admitted for a conflicting head of an owned pull request. */
export interface Repair extends PullRequestBinding {
  baseTip?: string;
}

export function repairInstruction({ pullRequest, baseTip }: Repair): string {
  const { url, commit, base } = pullRequest;
  return `Witch started this turn to repair the merge conflict on your existing task's pull request ${url}: head ${commit} conflicts with ${base}${baseTip ? `, whose tip was ${baseTip}` : ''}. This is not a new user request. First run gh pr view and stop if the pull request is no longer open, its head commit or base branch changed, or GitHub reports it MERGEABLE, or if the local branch isn't at ${commit}. Leave uncommitted changes not made in this turn untouched; if they would block the merge, or the project's rules for checks before publication require a clean checkout, stop and report them before merging. Without switching branches, fetch ${base} and merge it into the pull request branch without rebasing. Resolve each conflict so both sides' changes survive; stop on one that needs a product decision. Run the checks the project requires before publishing, following its pre-publication procedure where it has one and substituting ${base} for main in its fetch, merge and freshness commands; whenever ${base} has advanced again, merge it the same way and refresh the affected checks before pushing. Push without force. Don't merge or edit the pull request, and don't release the task. Stop and report anything that needs new authorization, within native permissions. When the repair can't finish, keep the merge and its resolution in the checkout unpushed and report the specific blocker. Report the merge commit and check results.`;
}

const key = ({
  url,
  commit,
  base,
}: Pick<PullRequest, 'url' | 'commit' | 'base'>) =>
  JSON.stringify([url, commit, base]);

interface RepairHost {
  record(): ConversationRecord | undefined;
  coordination(): SessionCoordination | undefined;
  /** idle for an automatic turn, with nothing queued. */
  ready(): boolean;
  queued(): boolean;
  notice(text: string): void;
  changed(): void;
  run(
    repair: Repair,
    refused: (error: string) => void,
  ): Promise<TurnResult | undefined>;
  interrupt(): Promise<void>;
}

/**
 * one automatic turn per conflicting head and base of the pull request this session claims. attempted keys are saved
 * on the record; a refused ownership check declines a key until the user's next prompt or another conversation.
 */
export class ConflictRepair {
  private repository?: Repository;
  private readonly declined = new Set<string>();
  private readonly noticed = new Set<string>();
  private executing?: Repair;
  private revoked?: Repair;

  constructor(private readonly host: RepairHost) {}

  observe(repository: Repository | undefined): void {
    this.repository = repository;
    this.checkBinding();
    if (!this.host.queued() && this.ready()) this.host.changed();
  }

  /** the latest read must still conflict at the recorded head, so a conflict kept through an `UNKNOWN` read isn't repaired. */
  private candidate() {
    const record = this.host.record();
    const coordination = this.host.coordination();
    const repository = this.repository;
    const conflict = repository?.conflict;
    const current = repository?.pullRequest;
    // the owner getter throws once the activation stops accepting work
    if (!record || !coordination?.reviews.observed || !conflict || !current)
      return;
    const { pullRequest } = conflict;
    const id = key(pullRequest);
    const claim = coordination.snapshot.ownClaim;
    if (
      current.mergeable !== 'CONFLICTING' ||
      current.url !== pullRequest.url ||
      current.commit !== pullRequest.commit ||
      repository.branch !== pullRequest.branch ||
      this.declined.has(id) ||
      record.conflictRepairs?.some((attempted) => key(attempted) === id) ||
      !claim ||
      claim.suggestion ||
      !claim.references.includes(
        taskReference(pullRequest.url, coordination.reviews.owner.project),
      )
    )
      return;
    return { record, claim: claim.id, conflict, id };
  }

  ready(): boolean {
    return !!this.candidate();
  }

  /** true once its turn was entered. */
  async run(): Promise<boolean> {
    const found = this.candidate();
    if (!found) return false;
    const { record, claim, conflict, id } = found;
    let refusal: string | undefined;
    try {
      if (
        !(await this.host
          .coordination()!
          .reviews.owns(claim, conflict.pullRequest))
      )
        refusal = '';
    } catch (error) {
      refusal = errorMessage(error);
    }
    // nothing may await between this check and the turn's admission
    const now = this.candidate();
    if (
      !now ||
      now.record !== record ||
      now.claim !== claim ||
      now.id !== id ||
      !this.host.ready()
    )
      return false;
    if (refusal !== undefined) {
      this.decline(record, conflict.pullRequest, refusal);
      return false;
    }
    const { url, commit, base } = conflict.pullRequest;
    (record.conflictRepairs ??= []).push({ url, commit, base });
    const repair: Repair = {
      owner: record.id,
      claim,
      pullRequest: conflict.pullRequest,
      ...(conflict.baseTip ? { baseTip: conflict.baseTip } : {}),
    };
    this.executing = repair;
    try {
      await this.host.run(repair, (error) => {
        record.conflictRepairs = record.conflictRepairs?.filter(
          (attempted) => key(attempted) !== id,
        );
        this.decline(record, repair.pullRequest, error);
      });
    } finally {
      this.executing = undefined;
    }
    return true;
  }

  /** the user's next prompt or another conversation lets a declined head be tried again. */
  resume(): void {
    this.declined.clear();
  }

  /** a repair stops once, without undoing its checkout, when its conversation, branch, base or claim changes. */
  checkBinding(): void {
    const repair = this.executing;
    if (!repair || this.revoked === repair) return;
    const current = this.repository?.pullRequest;
    if (
      !bindingChanged(
        repair,
        this.host.record()?.id,
        this.repository,
        this.host.coordination(),
      ) &&
      (!current || current.base === repair.pullRequest.base)
    )
      return;
    this.revoked = repair;
    this.host.notice(
      'Conflict repair stopped because its branch, base or task ownership changed.',
    );
    void this.host
      .interrupt()
      .catch((error: unknown) => this.host.notice(errorMessage(error)));
  }

  private decline(
    record: ConversationRecord,
    pullRequest: PullRequest,
    error: string,
  ): void {
    const id = key(pullRequest);
    this.declined.add(id);
    const text = `Witch didn't repair the conflict on #${pullRequest.number}: ${error || "this session's checkout or claim no longer matches it."}`;
    const shown = JSON.stringify([record.id, id, text]);
    if (this.noticed.has(shown)) return;
    this.noticed.add(shown);
    this.host.notice(text);
  }
}

/**
 * the notice is unsaved, so a launch on a conflicted branch can't make its new conversation resumable. a failed status
 * read keeps the last conflict, and merges recorded before the first pull request read are already covered by it.
 */
export function watchConflicts(
  repository: Pick<
    RepositoryWatch,
    'snapshot' | 'subscribe' | 'refreshPullRequest'
  >,
  coordinator: Pick<
    Coordinator,
    'snapshot' | 'subscribe' | 'notice' | 'conflict' | 'coordination' | 'repair'
  >,
): () => void {
  let conflict: Conflict | undefined;
  let pending: NodeJS.Immediate | undefined;
  let stopped = false;
  const check = () => {
    pending = undefined;
    const status = repository.snapshot;
    if (status) conflict = status.conflict;
    coordinator.conflict = conflict;
    coordinator.repair.observe(status);
    const { conversation, items } = coordinator.snapshot;
    if (!conflict || !conversation) return;
    const text = conflictNotice(conflict);
    if (!items.some((item) => item.kind === 'notice' && item.text === text))
      coordinator.notice(text, conversation.cwd, false);
  };
  const schedule = () => {
    if (!stopped) pending ??= setImmediate(check);
  };
  let seen: Set<string> | undefined;
  const coordination = coordinator.coordination;
  const merged = () => {
    const conversation = coordinator.snapshot.conversation;
    const request = repository.snapshot?.pullRequest;
    if (!coordination || !conversation || request?.state !== 'OPEN') return;
    const events = coordination.events.mergeEvents(conversation.id);
    const fresh = events.filter(({ id }) => !seen?.has(id));
    const first = !seen;
    seen ??= new Set();
    for (const { id } of fresh) seen.add(id);
    if (
      !first &&
      fresh.some(({ pullRequest }) => pullRequest.base === request.base)
    )
      repository.refreshPullRequest();
  };
  const stops = [
    repository.subscribe(schedule),
    coordinator.subscribe(schedule),
    ...(coordination ? [coordination.subscribe(merged)] : []),
  ];
  schedule();
  return () => {
    stopped = true;
    if (pending) clearImmediate(pending);
    for (const stop of stops) stop();
  };
}
