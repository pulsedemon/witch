import type { AgentRegistration } from '../agents/registry.js';
import type {
  BackgroundCommand,
  SessionInfo,
  Skill,
  Subagent,
  Usage,
  UserRequest,
} from '../agents/types.js';
import type { Conversation, DisplayItem, Phase } from './state.js';
import type { ModelChoice } from './models.js';

/** a listed subagent, when Witch saw its run start in epoch milliseconds, and the run's transcript rows. */
export interface TimedSubagent extends Subagent {
  startedAt: number;
  rows: { start: string; end?: string };
}

export interface Snapshot {
  phase: Phase;
  conversation?: Conversation;
  items: readonly DisplayItem[];
  /** prompts waiting for a turn, oldest first. */
  queue: readonly string[];
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
  /** when this instance opened the conversation, in epoch milliseconds. */
  openedAt?: number;
  /** a live completion signal; reopening never announces a stored result. */
  completedTurn?: string;
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
    agents: agents.map(({ adapter, executable }) => ({
      id: adapter.id,
      label: adapter.label,
      installed: !!executable,
    })),
  };
}
