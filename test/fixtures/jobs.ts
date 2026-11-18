import type { Row } from '../../src/core/jobs/jobs.js';

/**
 * invented pids sit above Linux's highest, 4194304, so none can be the test process's own pid, which a read
 * treats as Witch. a command with the agent's pid would be its own parent and never end a read.
 */
export const agentRow: Row = {
  pid: 5_100_000,
  ppid: process.pid,
  pgid: 5_100_000,
  name: 'node',
  leadsSession: false,
  identity: '5100000 a',
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
