import { errorMessage } from '../../errors.js';
import type { TurnResult } from '../../agents/types.js';
import { taskReference } from '../coordination/coordination-state.js';
import type { SessionCoordination } from '../coordination/coordination.js';
import type { Coordinator } from '../coordinator.js';
import type { Conflict, Repository, RepositoryWatch } from './repository.js';
import type { PullRequest } from './pull-requests.js';
import {
  bindingChanged,
  revoke,
  type PullRequestBinding,
} from './review-ownership.js';
import type { ConversationRecord } from '../state.js';

function conflictNotice(conflict: Conflict): string {
  const { number, url, commit, base } = conflict.pullRequest;

  return `Pull request conflict: [#${number}](${url}) at ${commit} conflicts with ${base}${conflict.baseTip ? `, observed at ${conflict.baseTip}` : ''}.`;
}

export function conflictContext(conflict: Conflict): string {
  const { number, url, commit, base } = conflict.pullRequest;

  return `Witch confirmed on GitHub that pull request #${number} (${url}) at head ${commit} conflicts with its base branch ${base}${conflict.baseTip ? `, whose tip was ${conflict.baseTip} when observed,` : ''} and hasn't confirmed a resolution since. Passing checks do not make it mergeable. This is informational, not a user request or authorization to change your task or checkout.`;
}

/** a repair Witch admitted for a conflicting head of an owned pull request, or for its head's failed checks. */
export interface Repair extends PullRequestBinding {
  baseTip?: string;
  failed?: NonNullable<PullRequest['failed']>;
}

export function repairInstruction(repair: Repair): string {
  if (repair.failed) return checkRepairInstruction(repair);

  const { url, commit, base } = repair.pullRequest;
  const { baseTip } = repair;

  return `Witch started this turn to repair the merge conflict on your existing task's pull request ${url}: head ${commit} conflicts with ${base}${baseTip ? `, whose tip was ${baseTip}` : ''}. This is not a new user request. First run gh pr view and stop if the pull request is no longer open, its head commit or base branch changed, or GitHub reports it MERGEABLE, or if the local branch isn't at ${commit}. Leave uncommitted changes not made in this turn untouched; if they would block the merge, or the project's rules for checks before publication require a clean checkout, stop and report them before merging. Without switching branches, fetch ${base} and merge it into the pull request branch without rebasing. Resolve each conflict so both sides' changes survive; stop on one that needs a product decision. Run the checks the project requires before publishing, following its pre-publication procedure where it has one and substituting ${base} for main in its fetch, merge and freshness commands; whenever ${base} has advanced again, merge it the same way and refresh the affected checks before pushing. Push without force. Don't merge or edit the pull request, and don't release the task. Stop and report anything that needs new authorization, within native permissions. When the repair can't finish, keep the merge and its resolution in the checkout unpushed and report the specific blocker. Report the merge commit and check results.`;
}

function checkRepairInstruction({
  pullRequest: { url, commit },
  failed = [],
}: Repair) {
  const checks = failed
    .map(({ name, url: page }) => (page ? `${name} (${page})` : name))
    .join(', ');

  return `Witch started this turn to repair the failed checks on your existing task's pull request ${url} at head ${commit}: ${checks}. This is not a new user request. First run gh pr view and stop if the pull request is no longer open, its head commit changed or those checks no longer fail, or if the local branch isn't at ${commit}. Read each failed check's log, for a GitHub Actions job with gh run view --job <job id from its URL> --log-failed, and find the cause. Leave uncommitted changes not made in this turn untouched. When the pull request's changes cause the failure, fix it, run the checks the project requires before publishing, following its pre-publication procedure where it has one, and push without force. When the cause is outside the change, fix it here or match it to an existing open or closed issue, filing one with the evidence, impact and a checkable completion condition when none matches, and only once that's settled rerun the failed jobs. Don't merge or edit the pull request, and don't release the task. Stop and report anything that needs new authorization, within native permissions. Report the cause, the commit or issue that settles it, and the check results.`;
}

const conflictKey = ({
  url,
  commit,
  base,
}: Pick<PullRequest, 'url' | 'commit' | 'base'>) =>
  JSON.stringify(['conflict', url, commit, base]);

const checkKey = ({
  url,
  commit,
  check,
}: Pick<PullRequest, 'url' | 'commit'> & { check: string }) =>
  JSON.stringify(['check', url, commit, check]);

/** one per failed check, so a check that fails later on the same head gets its own repair. */
const repairKeys = ({ pullRequest, failed }: Repair) =>
  failed
    ? failed.map(({ name }) => checkKey({ ...pullRequest, check: name }))
    : [conflictKey(pullRequest)];

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
 * one automatic turn per conflicting head and base of the pull request this session claims, and one per head for the
 * checks that failed on it since its last repair. attempted keys are saved on the record; a refused ownership check
 * declines a key until the user's next prompt or another conversation.
 */
export class PullRequestRepair {
  private repository?: Repository;
  private refresh?: () => Promise<void>;
  private readonly declined = new Set<string>();
  private readonly noticed = new Set<string>();
  private executing?: Repair;
  private revoked?: Repair;

  constructor(private readonly host: RepairHost) {}

  setRefresh(refresh: (() => Promise<void>) | undefined): void {
    this.refresh = refresh;
  }

  observe(repository: Repository | undefined): void {
    this.repository = repository;
    this.checkBinding();

    if (!this.host.queued() && this.ready()) this.host.changed();
  }

  /**
   * a conflict goes first. the latest read must still conflict at the recorded head, so a conflict kept through an
   * `UNKNOWN` read isn't repaired.
   */
  private candidate() {
    const record = this.host.record();
    const coordination = this.host.coordination();
    const repository = this.repository;
    const current = repository?.pullRequest;

    // the owner getter throws once the activation stops accepting work
    if (!record || !coordination?.reviews.observed || !current) return;

    const claim = coordination.snapshot.ownClaim;

    if (
      current.state !== 'OPEN' ||
      repository.branch !== current.branch ||
      !claim ||
      claim.suggestion ||
      !claim.references.includes(
        taskReference(current.url, coordination.reviews.owner.project),
      )
    )
      return;

    const conflict = repository.conflict;

    const conflicting =
      conflict &&
      current.mergeable === 'CONFLICTING' &&
      current.url === conflict.pullRequest.url &&
      current.commit === conflict.pullRequest.commit;

    if (conflicting && (!this.refresh || repository.commit !== current.commit))
      return;

    const recorded = [
      ...(record.conflictRepairs ?? []).map(conflictKey),
      ...(record.checkRepairs ?? []).map(checkKey),
    ];

    const open = (key: string) =>
      !this.declined.has(key) && !recorded.includes(key);

    const failed = current.failed?.filter(({ name }) =>
      open(checkKey({ ...current, check: name })),
    );

    const repair: Repair | undefined = conflicting
      ? open(conflictKey(conflict.pullRequest))
        ? {
            owner: record.id,
            claim: claim.id,
            pullRequest: conflict.pullRequest,
            ...(conflict.baseTip ? { baseTip: conflict.baseTip } : {}),
          }
        : undefined
      : failed?.length
        ? { owner: record.id, claim: claim.id, pullRequest: current, failed }
        : undefined;

    if (repair)
      return { record, id: JSON.stringify(repairKeys(repair)), repair };
  }

  ready(): boolean {
    return !!this.candidate();
  }

  /** true once its turn was entered. */
  async run(): Promise<boolean> {
    const found = this.candidate();

    if (!found) return false;

    const { record, id } = found;
    let { repair } = found;
    let refusal: string | undefined;

    try {
      if (!repair.failed) {
        await this.refresh!();
        const fresh = this.candidate();

        if (
          !fresh ||
          fresh.record !== record ||
          fresh.repair.claim !== repair.claim ||
          fresh.id !== id ||
          !this.host.ready()
        )
          return false;

        repair = fresh.repair;
      }

      if (
        !(await this.host
          .coordination()!
          .reviews.owns(repair.claim, repair.pullRequest))
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
      now.repair.claim !== repair.claim ||
      now.id !== id ||
      !this.host.ready()
    )
      return false;

    if (refusal !== undefined) {
      this.decline(record, repair, refusal);

      return false;
    }

    const { url, commit, base } = repair.pullRequest;

    if (repair.failed)
      (record.checkRepairs ??= []).push(
        ...repair.failed.map(({ name }) => ({ url, commit, check: name })),
      );
    else (record.conflictRepairs ??= []).push({ url, commit, base });

    this.executing = repair;

    try {
      await this.host.run(repair, (error) => {
        const keys = repairKeys(repair);

        record.checkRepairs = record.checkRepairs?.filter(
          (entry) => !keys.includes(checkKey(entry)),
        );

        record.conflictRepairs = record.conflictRepairs?.filter(
          (entry) => !keys.includes(conflictKey(entry)),
        );

        this.decline(record, repair, error);
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

    revoke(
      this.host,
      `${repair.failed ? 'Check' : 'Conflict'} repair stopped because its branch, base or task ownership changed.`,
    );
  }

  private decline(
    record: ConversationRecord,
    repair: Repair,
    error: string,
  ): void {
    const keys = repairKeys(repair);

    for (const entry of keys) this.declined.add(entry);

    const id = JSON.stringify(keys);
    const text = `Witch didn't repair the ${repair.failed ? 'failed checks' : 'conflict'} on #${repair.pullRequest.number}: ${error || "this session's checkout or claim no longer matches it."}`;
    const shown = JSON.stringify([record.id, id, text]);

    if (this.noticed.has(shown)) return;

    this.noticed.add(shown);
    this.host.notice(text);
  }
}

/**
 * the notice is unsaved, so a launch on a conflicted branch can't make its new conversation resumable. a failed status
 * read keeps the last conflict, and merges recorded before the first pull request read are already covered by it. a
 * pull request read that failed unexpectedly gets a notice too, once per failure and again in a transcript without it.
 */
export function watchConflicts(
  repository: Pick<
    RepositoryWatch,
    | 'snapshot'
    | 'subscribe'
    | 'refreshPullRequest'
    | 'readPullRequest'
    | 'pullRequestReadAt'
  >,
  coordinator: Pick<
    Coordinator,
    'snapshot' | 'subscribe' | 'notice' | 'conflict' | 'coordination' | 'repair'
  >,
): () => void {
  let conflict: Conflict | undefined;
  /** the read failure each notice was last shown for, until a read works. */
  let reported: string | undefined;
  let reportedLeft: string | undefined;
  let pending: NodeJS.Immediate | undefined;
  let stopped = false;

  const check = () => {
    pending = undefined;

    if (stopped) return;

    const status = repository.snapshot;

    if (status) conflict = status.conflict;

    coordinator.conflict = conflict;
    coordinator.repair.observe(status);
    const { conversation, items } = coordinator.snapshot;

    if (!conversation) return;

    const shown = (text: string) =>
      items.some((item) => item.kind === 'notice' && item.text === text);

    if (conflict && !shown(conflictNotice(conflict)))
      coordinator.notice(conflictNotice(conflict), conversation.cwd, false);

    /** posts a read failure unless its notice for that same failure still shows, and returns the failure reported. */
    const report = (what: string, failure?: string, last?: string) => {
      if (failure === undefined) return last;

      const text = `Can't read ${what}: ${failure}`;

      if (failure === last && shown(text)) return last;

      coordinator.notice(text, conversation.cwd, false);

      return failure;
    };

    reported = report(
      "this branch's pull request",
      status?.pullRequestFailure,
      reported,
    );

    reportedLeft = report(
      'a pull request this checkout left',
      status?.followedFailure,
      reportedLeft,
    );
  };

  const schedule = () => {
    if (!stopped) pending ??= setImmediate(check);
  };

  const seen = new Set<string>();
  // the start of the first open read, which covers merges recorded before it, even ones delivered later
  let opened: number | undefined;
  const coordination = coordinator.coordination;

  const merged = () => {
    const request = repository.snapshot?.pullRequest;

    if (request?.state !== 'OPEN') return;

    const boundary = (opened ??= repository.pullRequestReadAt);
    const conversation = coordinator.snapshot.conversation;

    if (!coordination || !conversation || boundary === undefined) return;

    const fresh = coordination.events
      .mergeEvents(conversation.id)
      .filter(({ id }) => !seen.has(id));

    for (const { id } of fresh) seen.add(id);

    if (
      fresh.some(
        ({ pullRequest, observedAt }) =>
          pullRequest.base === request.base &&
          Date.parse(observedAt) >= boundary,
      )
    )
      repository.refreshPullRequest();
  };

  // a merge delivered before the first open read publishes, or before the conversation opens, is checked once they do
  const changed = () => {
    const read = repository.snapshot;

    if (read?.pullRequest && read.pullRequestFailure === undefined)
      reported = undefined;

    if (read?.followed && read.followedFailure === undefined)
      reportedLeft = undefined;

    merged();
    schedule();
  };

  const stops = [
    repository.subscribe(changed),
    coordinator.subscribe(changed),
    ...(coordination ? [coordination.subscribe(merged)] : []),
  ];

  coordinator.repair.setRefresh(async () => {
    await repository.readPullRequest();
    check();
  });

  schedule();

  return () => {
    stopped = true;
    coordinator.repair.setRefresh(undefined);

    if (pending) clearImmediate(pending);

    for (const stop of stops) stop();
  };
}
