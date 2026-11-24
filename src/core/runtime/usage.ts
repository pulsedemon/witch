import type { AgentRegistration } from '../../agents/registry.js';
import { NativeStop } from '../../agents/shutdown.js';
import type {
  AccountReading,
  AgentSession,
  AgentStopOptions,
  ExhaustedLimit,
  Exhaustion,
  Funding,
  Limit,
  ModelLimit,
} from '../../agents/types.js';

/** older account observations cannot establish current capacity. */
export const USAGE_CURRENT_MS = 10 * 60_000;
/** a probe that hasn't answered by then is stopped, so a hung CLI doesn't hold its runtime's read. */
export const USAGE_PROBE_MS = 30_000;

/** observed within `USAGE_CURRENT_MS` and, when the window has a reset, before it. */
export function current(
  limit: Pick<Limit, 'observedAt' | 'resetsAt'>,
  now: number,
): boolean {
  return (
    now - limit.observedAt <= USAGE_CURRENT_MS &&
    (limit.resetsAt === undefined || limit.resetsAt * 1000 > now)
  );
}

/** what a percentage alone can't say: how soon the window resets, or `''` once it has. */
export function untilReset(resetsAt: number | undefined, now: number): string {
  const left = Math.floor((resetsAt ?? 0) - now / 1000);

  if (left <= 0) return '';

  if (left >= 86_400)
    return `${Math.floor(left / 86_400)}d${Math.floor((left % 86_400) / 3600)}h`;

  if (left >= 3600)
    return `${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m`;

  return `${Math.floor(left / 60)}m`;
}

/** whether there are limits and every window is current. */
export function currentLimits(limits: readonly Limit[], now: number): boolean {
  return limits.length > 0 && limits.every((limit) => current(limit, now));
}

/** a missing, empty, stale or reset window never counts as room to work. */
export function headroom(
  limits: readonly Limit[],
  shiftAt: number,
  now: number,
): boolean {
  return (
    currentLimits(limits, now) &&
    limits.every((limit) => limit.percent < shiftAt)
  );
}

export function over(
  limits: readonly Limit[],
  shiftAt: number,
  now: number,
): boolean {
  return limits.some(
    (limit) => current(limit, now) && limit.percent >= shiftAt,
  );
}

function words(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

/** a model-only window named for its models, as `7D Fable`. */
function named({ model, ...limit }: ModelLimit): Limit {
  return { ...limit, window: `${limit.window} ${model}` };
}

/** whether a runtime's model label names `model`, as `Fable` names `claude-fable-5-2`. */
function names(label: string, model: string | undefined): boolean {
  return `-${words(model ?? '')}-`.includes(`-${words(label)}-`);
}

/** the windows `model` runs under: those that block every model, then each model-only window whose label names it. */
export function limitsFor(
  account: AccountReading | undefined,
  model: string | undefined,
): readonly Limit[] {
  return [
    ...(account?.limits ?? []),
    ...(account?.modelLimits ?? [])
      .filter((limit) => names(limit.model, model))
      .map(named),
  ];
}

/** refresh windows, funding and eligibility independently within the existing attempt throttle. */
export function due(account: AccountReading | undefined, now: number): boolean {
  return (
    !account ||
    !currentLimits(account.limits, now) ||
    !account.funding ||
    !current(account.funding, now) ||
    (account.funding.kind === 'credits' && !account.creditAccess) ||
    (account.creditAccess !== undefined && !current(account.creditAccess, now))
  );
}

/**
 * the refused limit reset, or a reading observed after the refusal shows room or a balance above the lowest seen
 * since: Codex has reported usable credits in the bucket Witch reads while refusing for usage.
 */
function recovered(
  { exhausted, limits, modelLimits, funding, creditAccess }: AccountReading,
  now: number,
): boolean {
  const { at, limit, balance } = exhausted!;

  if (limit?.resetsAt !== undefined && limit.resetsAt * 1000 <= now)
    return true;

  const applicable = limit?.model
    ? limitsFor({ limits, modelLimits }, limit.model)
    : limits;

  if (
    applicable.every((window) => window.observedAt > at) &&
    headroom(applicable, 100, now)
  )
    return true;

  return (
    funding?.kind === 'credits' &&
    funding.observedAt > at &&
    current(funding, now) &&
    creditAccess?.state === 'available' &&
    creditAccess.observedAt > at &&
    current(creditAccess, now) &&
    (funding.unlimited ||
      (funding.available &&
        balance !== null &&
        funding.balance !== null &&
        Number(funding.balance) > Number(balance)))
  );
}

/** whether a usage refusal still blocks `model`; with no model, only a refusal that blocks every model counts. */
export function refused(
  account: AccountReading | undefined,
  model: string | undefined,
  now: number,
): boolean {
  const mark = account?.exhausted;

  return (
    !!mark &&
    (!mark.limit?.model || names(mark.limit.model, model)) &&
    !recovered(account, now)
  );
}

export function creditCapacity(
  account: AccountReading | undefined,
  now: number,
): 'available' | 'unavailable' | 'unknown' {
  if (refused(account, undefined, now)) return 'unavailable';

  const access = account?.creditAccess;

  if (!access || !current(access, now)) return 'unknown';

  if (access.state !== 'available') return access.state;

  const funding = account?.funding;

  return funding?.kind === 'credits' &&
    current(funding, now) &&
    (funding.available || funding.unlimited)
    ? 'available'
    : 'unknown';
}

function money(
  amount: number | null,
  currency: string | null,
  decimals: number | null | undefined,
): string {
  if (amount === null) return '?';

  if (decimals == null || !currency)
    return `${currency ? `${currency} ` : ''}${amount} minor units`;

  const [coefficient, exponent = '0'] = Math.abs(amount).toString().split('e');
  const [whole = '', fraction = ''] = coefficient!.split('.');
  const point = whole.length + Number(exponent) - decimals;
  const digits = whole + fraction;
  const integer = point > 0 ? digits.slice(0, point).padEnd(point, '0') : '0';

  const remainder =
    point < 0 ? '0'.repeat(-point) + digits : digits.slice(point);

  const tail = remainder.padEnd(decimals, '0');

  return `${currency} ${amount < 0 ? '-' : ''}${integer}${tail ? `.${tail}` : ''}`;
}

export function fundingText(funding: Funding): string {
  if (funding.kind === 'unavailable') return 'credits unavailable';

  if (funding.kind === 'extra-usage')
    return `extra ${funding.enabled ? 'on' : 'off'}: ${money(funding.used, funding.currency, funding.decimalPlaces)} spent / ${funding.limit === null ? 'unlimited' : money(funding.limit, funding.currency, funding.decimalPlaces)} cap`;

  if (funding.unlimited) return 'unlimited credits';

  if (funding.balance !== null) return `${funding.balance} credits`;

  return funding.available
    ? 'credits available; balance unavailable'
    : 'no credits';
}

/**
 * window and funding ages remain separate so a new window cannot renew an old balance.
 * `reading` defaults to every window, model-only ones included; a claim of room passes one model's own.
 */
export function describeReading(
  name: string,
  account: AccountReading | undefined,
  now: number,
  reading: readonly Limit[] = [
    ...(account?.limits ?? []),
    ...(account?.modelLimits ?? []).map(named),
  ],
): string | undefined {
  if (!account || (!reading.length && !account.funding)) return;

  const windows = reading
    .map(({ window, percent }) => `${window} ${Math.round(percent)}%`)
    .join(', ');

  const parts: string[] = [];

  const describe = (
    text: string,
    observed: readonly { observedAt: number; resetsAt?: number }[],
  ) => {
    if (observed.every((entry) => current(entry, now))) return text;

    const age = Math.floor(
      (now - Math.min(...observed.map(({ observedAt }) => observedAt))) /
        60_000,
    );

    return `${text}, not current (${age} minutes old)`;
  };

  if (windows) parts.push(describe(windows, reading));

  if (account.funding)
    parts.push(describe(fundingText(account.funding), [account.funding]));

  return `${name} ${parts.join(', ')}`;
}

/** the clause a switch notice opens with; without a window it says only that `name` ran out. */
export function describeExhaustion(
  name: string,
  limit: ExhaustedLimit | undefined,
  now: number,
): string {
  if (!limit?.window) return `${name} is out of usage`;

  const left = untilReset(limit.resetsAt, now);

  const details = [
    ...(left ? [`resets in ${left}`] : []),
    ...(limit.credits ? [`credits unavailable: ${limit.credits}`] : []),
  ];

  return `${name}'s ${limit.model ? `${limit.model} ` : ''}${limit.window} limit is used up${details.length ? ` (${details.join('; ')})` : ''}`;
}

/** dynamic account observations for the next turn. */
export function usageContext(
  accounts: Readonly<Record<string, AccountReading>>,
  agents: readonly { id: string; label: string }[],
  now: number,
): string | undefined {
  const readings = agents.flatMap(({ id, label }) => {
    const reading = describeReading(label, accounts[id], now);

    if (!reading) return [];

    const access = accounts[id]?.creditAccess;

    return [
      access
        ? `${reading}, credit execution ${creditCapacity(accounts[id], now)}`
        : reading,
    ];
  });

  return readings.length
    ? `Account usage: ${readings.join('; ')}. A reading older than ${USAGE_CURRENT_MS / 60_000} minutes or past its reset is not current.`
    : undefined;
}

/** a mark's balance after `reading`: the lowest credit balance observed since the refusal. */
function settle(mark: Exhaustion, { funding }: AccountReading): Exhaustion {
  if (
    funding?.kind !== 'credits' ||
    funding.balance === null ||
    funding.observedAt <= mark.at ||
    (mark.balance !== null && Number(funding.balance) >= Number(mark.balance))
  )
    return mark;

  return { ...mark, balance: funding.balance };
}

function sameMark(a: Exhaustion | undefined, b: Exhaustion | undefined) {
  return a === b || (a?.at === b?.at && a?.balance === b?.balance);
}

/** each runtime's latest reading, and the reads Witch starts for it; one read per runtime runs at a time. */
export class AccountUsage {
  private accounts: Record<string, AccountReading> = {};
  private readonly attempts = new Map<string, number>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly probes = new Map<AbortController, Promise<void>>();
  private closed = false;
  private session?: AgentSession;

  constructor(
    private readonly agents: readonly AgentRegistration[],
    private readonly publish: (
      accounts: Record<string, AccountReading>,
    ) => void,
  ) {}

  /** omitted account fields retain their observation; an empty window list clears windows. */
  report(agent: string, account: AccountReading | undefined): void {
    if (!account) return;

    const stored = this.accounts[agent];

    const previous =
      account.identity && account.identity !== stored?.identity
        ? undefined
        : stored;

    const { limits } = account;

    // a session's first report knows only its own windows, so one it leaves out keeps the earlier reading
    const kept = limits.length
      ? (previous?.limits ?? []).filter(
          ({ window }) => !limits.some((limit) => limit.window === window),
        )
      : [];

    const reading = kept.length ? [...limits, ...kept] : limits;

    this.store(agent, {
      ...previous,
      ...account,
      limits: reading,
      // a refusal recorded before the account identified itself still belongs to it
      exhausted: stored?.identity ? previous?.exhausted : stored?.exhausted,
    });
  }

  /** records a confirmed usage refusal; the first credit balance observed after it is the floor recovery must beat. */
  exhausted(agent: string, limit?: ExhaustedLimit): void {
    this.store(agent, {
      ...(this.accounts[agent] ?? { limits: [] }),
      exhausted: { at: Date.now(), ...(limit && { limit }), balance: null },
    });
  }

  private store(agent: string, reading: AccountReading): void {
    const previous = this.accounts[agent];
    const { exhausted, ...rest } = reading;
    const mark = exhausted && settle(exhausted, reading);

    const next: AccountReading =
      mark && !recovered({ ...rest, exhausted: mark }, Date.now())
        ? { ...rest, exhausted: mark }
        : rest;

    if (
      previous?.limits.length === next.limits.length &&
      next.limits.every((limit, index) => limit === previous.limits[index]) &&
      previous.modelLimits === next.modelLimits &&
      previous.funding === next.funding &&
      previous.creditAccess === next.creditAccess &&
      previous.identity === next.identity &&
      sameMark(previous.exhausted, next.exhausted)
    )
      return;

    this.accounts = { ...this.accounts, [agent]: next };
    this.publish(this.accounts);
  }

  /** a live session's connect read counts as its first attempt; later reads use its method or existing polling. */
  connected(session: AgentSession, cwd: string): void {
    this.session = session;
    this.attempts.set(session.info.agent, Date.now());
    this.others(session.info.agent, cwd);
  }

  context(
    agents: readonly { id: string; label: string }[],
  ): string | undefined {
    return usageContext(this.accounts, agents, Date.now());
  }

  others(live: string, cwd: string): void {
    for (const { adapter } of this.agents)
      if (adapter.id !== live) void this.refresh(adapter.id, cwd);
  }

  /** `force` skips only the attempt throttle, for a decision that can't wait for it. `after` also rereads a reading with an observation from before it. */
  refresh(
    agent: string,
    cwd: string,
    { force = false, after = -Infinity } = {},
  ): Promise<void> {
    const running = this.reads.get(agent);

    if (running) return running;

    const now = Date.now();
    const account = this.accounts[agent];

    const observed = [
      ...(account?.limits ?? []),
      account?.funding,
      account?.creditAccess,
    ];

    if (
      this.closed ||
      (!due(account, now) &&
        observed.every((item) => !item || item.observedAt > after)) ||
      (!force &&
        now - (this.attempts.get(agent) ?? -Infinity) <= USAGE_CURRENT_MS)
    )
      return Promise.resolve();

    const live =
      this.session?.info.agent === agent && !this.session.closed
        ? this.session
        : undefined;

    const read = live ? live.readAccountUsage?.() : this.probe(agent, cwd);

    if (!read) return Promise.resolve();

    this.attempts.set(agent, now);
    const settled = read.finally(() => this.reads.delete(agent));
    this.reads.set(agent, settled);

    return settled;
  }

  async close(stop: AgentStopOptions): Promise<void> {
    this.closed = true;

    for (const abort of this.probes.keys()) abort.abort(new NativeStop(stop));

    await Promise.allSettled(this.probes.values());
  }

  private probe(agent: string, cwd: string): Promise<void> | undefined {
    const registration = this.agents.find(
      ({ adapter, executable }) => adapter.id === agent && executable,
    );

    if (!registration) return;

    const abort = new AbortController();

    const timer = setTimeout(
      () => abort.abort(new Error(`${agent} usage read timed out`)),
      USAGE_PROBE_MS,
    );

    timer.unref();
    const previous = this.accounts[agent];

    const probe = registration.adapter
      .accountUsage(
        { cwd, executable: registration.executable!, signal: abort.signal },
        previous ?? { limits: [] },
      )
      .then((reading) => {
        if (this.closed) return;

        const current = this.accounts[agent];

        if (current?.identity !== previous?.identity) return;

        if (
          current === previous ||
          (reading.identity && reading.identity !== current?.identity)
        ) {
          this.report(agent, reading);

          return;
        }

        const changed = (window: string) =>
          current?.limits.find((entry) => entry.window === window) !==
          previous?.limits.find((entry) => entry.window === window);

        const limits = reading.limits.length
          ? reading.limits.flatMap((limit) => {
              if (!changed(limit.window)) return [limit];

              const newer = current?.limits.find(
                (entry) => entry.window === limit.window,
              );

              return newer ? [newer] : [];
            })
          : (current?.limits ?? []).filter((limit) => changed(limit.window));

        this.store(agent, {
          ...current,
          ...reading,
          limits: reading.limits.length
            ? [
                ...limits,
                ...(current?.limits ?? []).filter(
                  (entry) =>
                    !reading.limits.some(
                      (limit) => limit.window === entry.window,
                    ),
                ),
              ]
            : limits,
          ...(current?.funding !== previous?.funding
            ? { funding: current?.funding }
            : {}),
          ...(current?.creditAccess !== previous?.creditAccess
            ? { creditAccess: current?.creditAccess }
            : {}),
          ...(current?.modelLimits !== previous?.modelLimits
            ? { modelLimits: current?.modelLimits }
            : {}),
          // the adapter echoes the reading the probe started from, which can hold an older mark
          exhausted: current?.exhausted,
        });
      })
      // a failed read leaves the reading to age until the next attempt
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        this.probes.delete(abort);
      });

    this.probes.set(abort, probe);

    return probe;
  }
}
