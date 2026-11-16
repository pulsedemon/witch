import { z } from 'zod';
import { hunks, wholeFile } from '../file-diff.js';
import { boundCommandTitle, shortPath, toolTitle } from '../tool-title.js';
import type { CommandPrefixes, ToolTitle } from '../tool-title.js';
import type { AgentEvent, FileDiff } from '../types.js';

export function fileDiffs(changes: z.infer<typeof fileChanges>): FileDiff[] {
  return changes.map(({ path, kind, diff }) =>
    kind.type === 'update'
      ? {
          path,
          kind: 'update',
          ...(kind.move_path ? { movePath: kind.move_path } : {}),
          hunks: hunks(diff),
        }
      : wholeFile(path, kind.type, diff),
  );
}

const changedFiles = z.array(z.object({ path: z.string() })).catch([]);

export const fileChanges = z.array(
  z.object({
    path: z.string(),
    kind: z.object({
      type: z.enum(['add', 'delete', 'update']),
      move_path: z.string().nullish(),
    }),
    diff: z.string(),
  }),
);

export function fileChangeKey(
  threadId: string,
  turnId: string,
  itemId: string,
): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

export const fileChangeIdentity = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
});

const mcpCall = z.object({
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown(),
});

const imageContent = z.object({
  type: z.literal('image'),
  data: z.string(),
  mimeType: z.string(),
});

const mcpResult = z.object({ content: z.array(z.unknown()) });
export const turnId = z.object({ turn: z.object({ id: z.string() }) });

export const completedTurn = z.object({
  turn: z.object({ id: z.string(), status: z.string() }),
});

/** item types besides agentMessage that get no tool row or familiar activity. */
export const untooled = ['userMessage', 'reasoning', 'contextCompaction'];

/** Witch's names for Codex's collab tools; a tool added later keeps its native name. */
const collabNames = new Map([
  ['spawnAgent', 'Familiar'],
  ['sendInput', 'Send input to familiar'],
  ['resumeAgent', 'Resume familiar'],
  ['wait', 'Wait for familiar'],
  ['closeAgent', 'Close familiar'],
  ['sendMessage', 'Message familiar'],
  ['followupTask', 'Follow-up task for familiar'],
  ['interruptAgent', 'Interrupt familiar'],
  ['listAgents', 'List familiars'],
]);

/** an item's name and what it acts on; a command shows as itself. */
export function itemTitle(
  type: string,
  item: Record<string, unknown>,
  cwd: string,
  prefixes?: CommandPrefixes,
): ToolTitle {
  if (type === 'commandExecution' && typeof item.command === 'string') {
    const bound = boundCommandTitle(item.command, prefixes);

    return { ...(bound ?? { title: item.command }), command: true };
  }

  if (typeof item.command === 'string') return { title: item.command };

  if (type === 'fileChange')
    return {
      title: [
        type,
        ...changedFiles
          .parse(item.changes)
          .map(({ path }) => shortPath(path, cwd)),
      ].join('  '),
    };

  const call = type === 'mcpToolCall' ? mcpCall.safeParse(item) : undefined;

  if (call?.success)
    return toolTitle(
      `${call.data.server}.${call.data.tool}`,
      call.data.arguments,
      cwd,
    );

  if (type === 'subAgentActivity') return toolTitle('Familiar', item, cwd);

  if (typeof item.tool === 'string')
    return toolTitle(
      (type === 'collabAgentToolCall' && collabNames.get(item.tool)) ||
        item.tool,
      item.arguments ?? item,
      cwd,
    );

  return toolTitle(type, item, cwd);
}

function itemFailed(item: Record<string, unknown>): boolean {
  return (
    item.status === 'failed' ||
    item.status === 'declined' ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
  );
}

/** a viewed image file, or the images an MCP tool returned. */
function itemImages(type: string, item: Record<string, unknown>): string[] {
  if (type === 'imageView' && typeof item.path === 'string') return [item.path];

  const result = mcpResult.safeParse(item.result);

  if (!result.success) return [];

  return result.data.content.flatMap((part) => {
    const image = imageContent.safeParse(part);

    return image.success
      ? [`data:${image.data.mimeType};base64,${image.data.data}`]
      : [];
  });
}

export function itemTool(
  item: Record<string, unknown>,
  done: boolean,
  cwd: string,
  prefixes?: CommandPrefixes,
  diff?: FileDiff[],
  command?: string,
): Extract<AgentEvent, { type: 'tool' }> {
  const id = z.string().parse(item.id);
  const type = z.string().parse(item.type);
  const images = itemImages(type, item);

  return {
    type: 'tool',
    id,
    ...(command === undefined
      ? itemTitle(type, item, cwd, prefixes)
      : { title: command }),
    // a change's diff comes before it applies and stays after it fails or is declined
    text: diff
      ? item.status === 'failed' || item.status === 'declined'
        ? `Patch ${item.status}`
        : ''
      : typeof item.aggregatedOutput === 'string'
        ? item.aggregatedOutput
        : type === 'commandExecution'
          ? ''
          : // image data shows as the image, not as base64 text
            JSON.stringify(
              item,
              (_key, value: unknown) =>
                typeof value === 'object' &&
                value !== null &&
                'type' in value &&
                value.type === 'image' &&
                imageContent.safeParse(value).success
                  ? { ...value, data: '…' }
                  : value,
              2,
            ),
    done,
    cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
    ...(images.length ? { images } : {}),
    ...(diff ? { diff } : {}),
    ...(command === undefined ? {} : { shell: true }),
    ...(done && itemFailed(item) ? { failed: true } : {}),
  };
}
