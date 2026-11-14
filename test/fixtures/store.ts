import type { Conversation } from '../../src/core/state.js';

export function conversation(id: string, cwd = '/project'): Conversation {
  return {
    id,
    title: id,
    cwd,
    agent: 'codex',
    sessions: {},
    createdAt: new Date().toISOString(),
  };
}
