import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill, SkillCall } from '../agents/types.js';
import { indexByteLimit, indexNote } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type { Conversation } from './state.js';

// an agent can read `!cmd` as a request to run it, which would run a git pull or a paid test run twice
export const ranCommand =
  'The user ran this command themselves, and its output is above. Reply to it without running it again.';

/** splits `/name args` as Claude Code does: the name ends at the first whitespace. */
export function skillCall(
  prompt: string,
  skills: readonly Skill[],
): SkillCall | undefined {
  const match = /^\/(\S+)([\s\S]*)$/.exec(prompt.trim());
  if (!match || !skills.some(({ name }) => name === match[1])) return;
  return { name: match[1]!, args: match[2]!.trim() };
}

/** a slash command or `!` command takes a turn alone: a spell runs only from a turn's prompt, listed or not before its session connects, Claude Code would run any other slash command as its own, and a `!` command's reply is a turn of its own. */
export function alone(prompt: string): boolean {
  return (
    prompt.trimStart().startsWith('/') || shellCommand(prompt) !== undefined
  );
}

/** the command a `!` prompt runs. */
export function shellCommand(prompt: string): string | undefined {
  return prompt.startsWith('!') ? prompt.slice(1) : undefined;
}

export async function nativePrompt({
  prompt,
  memory,
  workspace,
  scope,
  revision,
  reference,
  pendingHandoff,
  coordination,
  pendingContext,
  command,
}: {
  prompt: string;
  memory: Memory;
  workspace: Workspace;
  scope: MemoryScope;
  revision: string;
  reference: Conversation['sessions'][string];
  pendingHandoff?: Conversation['handoff'];
  coordination?: string;
  pendingContext?: readonly string[];
  command?: string;
}): Promise<string> {
  const root = workspace.root;
  // the project marker moves before delivery, even when the turn later fails
  if (reference.deliveredProject !== scope.project) {
    delete reference.deliveredRevision;
    reference.deliveredProject = scope.project;
  }
  const snapshot =
    reference.deliveredRevision === revision
      ? undefined
      : await memory.snapshot(
          revision,
          root,
          scope,
          reference.deliveredRevision,
        );
  return [
    'You are running inside Witch. Follow your native and project instructions.',
    `Shared memory directories: ${join(root, scope.global)} and ${join(root, scope.project)}.`,
    `Save only new lasting preferences, decisions and verified reusable facts with ordinary file tools before finishing useful work. When nothing durable changed, write nothing. Put user-wide preferences in global memory and project facts in project memory. Keep each ${indexNote} within ${indexByteLimit} UTF-8 bytes as current essentials and short reference links. Put technical detail in topic notes and label historical records. Update existing facts instead of adding status paragraphs. Keep planning, test, commit, publication and review progress out of the indexes. Keep task state in its plan or ledger and current repository state in Git/GitHub. Link to existing project documentation instead of copying it. Keep credentials and temporary handoffs out of memory. Witch owns memory Git commits; do not run Git in those memory directories.`,
    `Put scratch files under ${tmpdir()} rather than /tmp, with \`mktemp -d -p "$TMPDIR"\`, since a plain \`mktemp -d\` ignores TMPDIR on macOS. Witch preserves this directory across /restart. After this Witch exits, a later cleanup pass may remove it once its remaining users have ended. Uncertain use delays cleanup. Save files you need to keep outside scratch.`,
    ...(snapshot ? [snapshot] : []),
    ...(pendingHandoff?.summary
      ? [
          `Pending task context from ${pendingHandoff.from}:\n${pendingHandoff.summary}`,
        ]
      : []),
    ...(coordination ? [coordination] : []),
    ...(pendingContext
      ? [
          'These commands already ran before an interrupt. Use their output as context without running them again:',
          ...pendingContext,
        ]
      : []),
    `User request:\n${prompt}`,
    ...(command === undefined ? [] : [ranCommand]),
  ].join('\n\n');
}
