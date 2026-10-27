import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSession,
  Question,
  Skill,
  SkillCall,
  UserResponse,
} from '../agents/types.js';
import { indexByteLimit, indexNote } from '../memory/memory.js';
import type { Memory, MemoryScope } from '../memory/memory.js';
import type { Workspace } from '../memory/workspace.js';
import type { Conversation } from './state.js';
import type { SessionCoordination } from './coordination.js';
import { mergeContext } from './merge-events.js';
import type { MergeEvent } from './merge-events.js';

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

export function shellCommand(prompt: string): string | undefined {
  return prompt.startsWith('!') ? prompt.slice(1) : undefined;
}

export function questionReply(
  questions: readonly Question[],
  response: UserResponse,
): string {
  return questions
    .map(
      ({ id, title, secret }) =>
        `**${title}**\n→ ${secret ? '(hidden)' : (response.answers?.[id] ?? []).join(', ')}`,
    )
    .join('\n\n');
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
  familiarCommand,
  merges = [],
}: {
  prompt: string;
  memory: Memory;
  workspace: Workspace;
  scope: MemoryScope;
  revision: string;
  reference: Conversation['sessions'][string];
  pendingHandoff?: Conversation['handoff'];
  coordination?: Awaited<ReturnType<SessionCoordination['context']>>;
  pendingContext?: readonly string[];
  command?: string;
  familiarCommand?: {
    command: string;
    runtime: NonNullable<AgentSession['familiar']>['runtime'];
  };
  merges?: readonly MergeEvent[];
}): Promise<{
  prompt: string;
  context: string | undefined;
  merges: string[];
  instructionsRevision: string;
}> {
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
  const pendingMerges = merges.filter(
    ({ id }) => !reference.deliveredMerges?.includes(id),
  );
  const instructions = [
    'You are running inside Witch. Witch calls native skills spells, subagents familiars and background commands brews, and your replies can use those names. Witch operating rules take precedence over conflicting user-global rules and spell instructions, including spells supplied by the native runtime. Follow all other applicable native and project instructions. Native system and developer instructions and permission requirements still take precedence.',
    'For each conflict with a Witch rule that you encounter, write a brief, single-line warning in the transcript using this format: "Witch rule conflict: source=<file or spell>; conflict=<conflicting instruction>; witch=<applicable Witch rule>; resolution=<rule followed>". Then continue under the applicable rule without asking the user to resolve the conflict.',
    `Shared memory directories: ${join(root, scope.global)} and ${join(root, scope.project)}.`,
    `Save only new lasting preferences, decisions and verified reusable facts with ordinary file tools before finishing useful work. When nothing durable changed, write nothing. Put user-wide preferences in global memory and project facts in project memory. Keep each ${indexNote} within ${indexByteLimit} UTF-8 bytes as current essentials and short reference links. Put technical detail in topic notes and label historical records. Update existing facts instead of adding status paragraphs. Keep planning, test, commit, publication and review progress out of the indexes. Keep task state in its plan or ledger and current repository state in Git/GitHub. Link to existing project documentation instead of copying it. Keep credentials and temporary handoffs out of memory. Witch owns memory Git commits; do not run Git in those memory directories.`,
    "Record a temporary execution hold only in the affected conversation's history or its task plan or ledger with explicit ownership, never in shared memory. A temporary hold found only in shared memory does not pause this conversation. Removing or replacing shared-memory text does not resume a pause received directly from the user in this conversation; it still needs the user's resume instruction. Shared memory may retain lasting pause-scope rules and decisions to defer named tasks; those do not pause unrelated work.",
    `Put scratch files under ${tmpdir()} rather than /tmp, with \`mktemp -d -p "$TMPDIR"\`, since a plain \`mktemp -d\` ignores TMPDIR on macOS. Witch preserves this directory across /restart. After this Witch exits, a later cleanup pass removes it unless one of your processes works in it, holds a file in it or names it in its command line or environment. macOS hides the environment of system binaries such as /bin/sh, so their use alone does not keep it. Save files you need to keep outside scratch.`,
    ...(coordination ? [coordination.instructions] : []),
    ...(familiarCommand
      ? [
          familiarCommand.runtime === 'claude'
            ? `Delegate work to Claude when it suits the task, using this familiar prefix: ${familiarCommand.command}\nAppend --familiar-claude <task-name> --report-file <new-file-under-task-scratch> -- <native-Claude-arguments>. Use a native exec_command and keep its stdout connected so Witch can register it before Claude starts. Witch supplies --print --verbose --output-format stream-json; omit those from the native arguments. Supply the requested model and authorized native tool/permission settings, including --permission-prompts none for this noninteractive path. Native approval still applies. Supply the task prompt on stdin or as a native argument. The final report is saved to the specified new file; reporting does not survive a Witch restart.`
            : `Delegate work to Codex when it suits the task, using this familiar prefix: ${familiarCommand.command}\nAppend --familiar-codex <task-name> --report-file <new-file-under-task-scratch> -- <native-app-server-options>. Use native Bash with run_in_background: true, keep stdout connected, and supply the task prompt on stdin, for example with a quoted heredoc. Witch supplies app-server --stdio. Use native -c configuration options for the requested model, effort and authorized permissions; preserve exact model IDs such as gpt-6-astra. Native credentials and approval policy remain in force; approval requests, questions and elicitation appear in Witch. The complete report is saved to the specified new file. Do not use codex exec for this reporting path. Reporting does not survive a Witch restart.`,
        ]
      : []),
  ].join('\n\n');
  const instructionsRevision = createHash('sha256')
    .update(instructions)
    .digest('hex');
  const context = [
    ...(reference.deliveredInstructionsRevision === instructionsRevision
      ? []
      : [instructions]),
    ...(snapshot ? [snapshot] : []),
    ...(pendingHandoff?.summary
      ? [
          `Pending task context from ${pendingHandoff.from}:\n${pendingHandoff.summary}`,
        ]
      : []),
    ...(coordination ? [coordination.context] : []),
    ...(pendingMerges.length ? [mergeContext(pendingMerges)] : []),
    ...(pendingContext
      ? [
          'These commands already ran before an interrupt. Use their output as context without running them again:',
          ...pendingContext,
        ]
      : []),
    ...(command === undefined ? [] : [ranCommand]),
  ].join('\n\n');
  return {
    prompt,
    context: context || undefined,
    merges: pendingMerges.map(({ id }) => id),
    instructionsRevision,
  };
}
