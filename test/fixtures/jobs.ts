import type { Row } from '../../src/core/jobs.js';

/** an agent whose pid is above macOS's highest, since a command with the agent's pid would be its own parent and never end a read. */
export const agentRow: Row = {
  pid: 100_000,
  ppid: process.pid,
  pgid: 100_000,
  name: 'node',
  leadsSession: false,
  identity: '100000 a',
};

export function commandRows(group: number, identity: string): Row[] {
  return [
    agentRow,
    {
      pid: group,
      ppid: agentRow.pid,
      pgid: group,
      name: 'sh',
      leadsSession: true,
      identity,
    },
  ];
}

/** describes each process as the leader of `pgid`, or of its own group without one. */
export const groupLeaders = (pgid?: number) => async (pids: number[]) =>
  pids.map((pid) => ({
    pid,
    pgid: pgid ?? pid,
    cpu: 0,
    startedAt: 0,
    command: '',
  }));

export const leaders = groupLeaders();

/** a process launchd adopted, alone in a group of its own unless given `pgid`. */
export function orphanRow(pid: number, pgid = pid): Row {
  return {
    pid,
    ppid: 1,
    pgid,
    name: 'node',
    leadsSession: false,
    identity: `${pid} a`,
  };
}
