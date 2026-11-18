import type { AgentRegistration } from '../agents/registry.js';
import type {
  BackgroundCommand,
  AccountReading,
  SessionInfo,
  Skill,
  Subagent,
  Usage,
  UserRequest,
} from '../agents/types.js';
import type { Conversation, DisplayItem, Phase } from './state.js';
import type { ModelChoice } from './runtime/models.js';

/** a listed subagent, when Witch saw its run start in epoch milliseconds, and the run's transcript rows. */
export interface TimedSubagent extends Subagent {
  startedAt: number;
  rows: { start: string; end?: string };
}

export interface Snapshot {
  phase: Phase;
  /** when the current or last uninterrupted working period began, in epoch milliseconds. */
  activityStartedAt: number;
  conversation?: Conversation;
  items: readonly DisplayItem[];
  /** prompts waiting for a turn, oldest first. */
  queue: readonly string[];
  /** the opened conversation's saved composer text. */
  draft?: string;
  commandsPending: boolean;
  pendingCompaction: boolean;
  requests: readonly UserRequest[];
  models: readonly ModelChoice[];
  skills: readonly Skill[];
  /** the live session's subagents in start order; a turn drops the finished ones. */
  subagents: readonly TimedSubagent[];
  /** the live session's running background commands, which Witch calls brews, in start order. */
  backgroundCommands: readonly BackgroundCommand[];
  agents: readonly { id: string; label: string; installed: boolean }[];
  native?: SessionInfo;
  usage: Usage;
  /** merged account readings outlast the native session that reported them. */
  accounts: Readonly<Record<string, AccountReading>>;
  /** each runtime's family aliases and the concrete model each names, read past native pins. */
  latest: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** when this instance opened the conversation, in epoch milliseconds. */
  openedAt?: number;
  /** a live completion signal; reopening never announces a stored result. */
  completedTurn?: string;
  /** the native agent reports it runs, as Claude Code does on its own when a brew ends. */
  nativeRunning?: boolean;
  /** when an agent last reported reasoning from its live session, in epoch milliseconds; a switch of runtime keeps it. */
  reasonedAt?: number;
  /** a Witch-started turn answering peer requests holds the phase. */
  answering?: boolean;
  /** Witch is admitting, running or reconciling a turn it started itself: a peer answer, a repair or Copilot feedback. */
  automatic?: boolean;
  /** a Witch-started turn handling Copilot feedback holds the phase. */
  reviewing?: boolean;
  recovery?: Recovery;
  error?: string;
}

export interface Recovery {
  kind: 'pending' | 'conflict';
  /** the conflicting paths; empty when the conflict has no single path. */
  paths: string[];
  diff: string;
  root: string;
}

export function initialSnapshot(
  agents: readonly AgentRegistration[],
): Snapshot {
  return {
    phase: 'starting',
    activityStartedAt: Date.now(),
    items: [],
    queue: [],
    commandsPending: false,
    pendingCompaction: false,
    requests: [],
    models: [],
    skills: [],
    subagents: [],
    backgroundCommands: [],
    usage: {},
    accounts: {},
    latest: {},
    agents: agents.map(({ adapter, executable }) => ({
      id: adapter.id,
      label: adapter.label,
      installed: !!executable,
    })),
  };
}
