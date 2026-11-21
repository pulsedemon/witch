import type { Conversation } from '../../src/core/state.js';

export function record(
  id: string,
  cwd = '/project',
  agent = 'a',
): Conversation {
  return {
    id,
    title: `Title ${id}`,
    cwd,
    agent,
    sessions: {},
    createdAt: new Date().toISOString(),
  };
}
