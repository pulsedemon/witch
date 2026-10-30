import type { AgentRegistration } from '../agents/registry.js';
import { NativeStop } from '../agents/shutdown.js';
import type { AgentSession, AgentStopOptions, Limit } from '../agents/types.js';

/** a chosen bound: usage within a window only grows, so an older reading can hide a limit already reached. */
export const USAGE_CURRENT_MS = 10 * 60_000;

/** a probe that hasn't answered by then is stopped, so a hung CLI doesn't hold its runtime's read. */
export const USAGE_PROBE_MS = 30_000;

/** observed within `USAGE_CURRENT_MS` and, when the window has a reset, before it. */
export function current(limit: Limit, now: number): boolean {
  return (
    now - limit.observedAt <= USAGE_CURRENT_MS &&
    (limit.resetsAt === undefined || limit.resetsAt * 1000 > now)
  );
}

/** a missing, empty, stale or reset window never counts as room to work. */
export function headroom(
  limits: readonly Limit[],
  shiftAt: number,
  now: number,
): boolean {
  return (
    limits.length > 0 &&
    limits.every((limit) => current(limit, now) && limit.percent < shiftAt)
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

/** no window, or one that isn't current, so another read could change a decision. */
export function due(limits: readonly Limit[], now: number): boolean {
  return limits.length === 0 || limits.some((limit) => !current(limit, now));
}

/** `Codex 7D 49%`, with the oldest window's age when one isn't current; `undefined` with no window. */
export function describeReading(
  name: string,
  reading: readonly Limit[] | undefined,
  now: number,
): string | undefined {
  if (!reading?.length) return;
  const windows = reading
    .map(({ window, percent }) => `${window} ${Math.round(percent)}%`)
    .join(', ');
  if (reading.every((limit) => current(limit, now)))
    return `${name} ${windows}`;
  const age = Math.floor(
    (now - Math.min(...reading.map(({ observedAt }) => observedAt))) / 60_000,
  );
  return `${name} ${windows}, not current (${age} minutes old)`;
}

/** one context line for the agent; a runtime with no window is left out, and none at all leaves no line. */
export function usageContext(
  limits: Readonly<Record<string, readonly Limit[]>>,
  agents: readonly { id: string; label: string }[],
  now: number,
): string | undefined {
  const readings = agents.flatMap(({ id, label }) => {
    const reading = describeReading(label, limits[id], now);
    return reading ? [reading] : [];
  });
  return readings.length
    ? `Account usage: ${readings.join('; ')}. A reading older than ${USAGE_CURRENT_MS / 60_000} minutes or past its reset is not current.`
    : undefined;
}

/** each runtime's latest reading, and the reads Witch starts for it; one read per runtime runs at a time. */
export class AccountUsage {
  private limits: Record<string, Limit[]> = {};
  /** counts each runtime's reports, so a probe that started before a newer one doesn't replace it. */
  private readonly reports = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly probes = new Map<AbortController, Promise<void>>();
  private closed = false;
  private session?: AgentSession;

  constructor(
    private readonly agents: readonly AgentRegistration[],
    private readonly publish: (limits: Record<string, Limit[]>) => void,
  ) {}

  /** what a runtime reported; a report without limits leaves its reading alone. */
  report(agent: string, limits: Limit[] | undefined): void {
    if (!limits || this.limits[agent] === limits) return;
    this.reports.set(agent, (this.reports.get(agent) ?? 0) + 1);
    this.limits = { ...this.limits, [agent]: limits };
    this.publish(this.limits);
  }

  /** a live session reads its own limits as it connects, which counts as that runtime's attempt; later reads go through its `readLimits`, or wait on its own polling without one. */
  connected(session: AgentSession, cwd: string): void {
    this.session = session;
    this.attempts.set(session.info.agent, Date.now());
    this.others(session.info.agent, cwd);
  }

  context(
    agents: readonly { id: string; label: string }[],
  ): string | undefined {
    return usageContext(this.limits, agents, Date.now());
  }

  others(live: string, cwd: string): void {
    for (const { adapter } of this.agents)
      if (adapter.id !== live) void this.refresh(adapter.id, cwd);
  }

  refresh(agent: string, cwd: string): Promise<void> {
    const running = this.reads.get(agent);
    if (running) return running;
    const now = Date.now();
    if (
      this.closed ||
      !due(this.limits[agent] ?? [], now) ||
      now - (this.attempts.get(agent) ?? -Infinity) <= USAGE_CURRENT_MS
    )
      return Promise.resolve();
    const live =
      this.session?.info.agent === agent && !this.session.closed
        ? this.session
        : undefined;
    const read = live ? live.readLimits?.() : this.probe(agent, cwd);
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
    const reports = this.reports.get(agent) ?? 0;
    const probe = registration.adapter
      .limits(
        { cwd, executable: registration.executable!, signal: abort.signal },
        this.limits[agent] ?? [],
      )
      .then((limits) => {
        if (!this.closed && (this.reports.get(agent) ?? 0) === reports)
          this.report(agent, limits);
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
