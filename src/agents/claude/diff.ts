import fs from 'node:fs/promises';
import { structuredPatch } from 'diff';
import { z } from 'zod';
import { resolveFile } from '../../paths.js';
import { escapeRegExp } from '../../regexp.js';
import type { FileDiff } from '../types.js';
import { wholeFile } from '../file-diff.js';

/** what Claude Code's Edit and Write report of the file they changed. */
const fileResult = z.object({
  filePath: z.string(),
  type: z.enum(['create', 'update']).optional(),
  content: z.string().optional(),
  oldString: z.string().optional(),
  staged: z.boolean().optional(),
  structuredPatch: z.array(
    z.object({
      oldStart: z.number(),
      newStart: z.number(),
      lines: z.array(z.string()),
    }),
  ),
});

/** a staged result is held for review and has not changed the file. */
export function reportedDiff(
  report: unknown,
  cwd: string,
): FileDiff[] | undefined {
  const parsed = fileResult.safeParse(report);

  if (!parsed.success || parsed.data.staged) return undefined;

  const { filePath, type, content, oldString, structuredPatch } = parsed.data;
  const path = resolveFile(filePath, cwd);

  if (type === 'create') return [wholeFile(path, 'add', content ?? '')];

  return structuredPatch.length
    ? [
        {
          path,
          kind: oldString === '' ? 'add' : 'update',
          hunks: structuredPatch,
        },
      ]
    : undefined;
}

const unicodeEscape = /\\u[0-9a-fA-F]{4}/;
const nonAscii = /[\u0080-\uffff]/;

const plainQuotes = (text: string) =>
  text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

function decodeEscapes(text: string): string {
  return text.replace(
    /(\\\\)|\\u([0-9a-fA-F]{4})/g,
    (match: string, escaped: string | undefined, hex: string | undefined) =>
      escaped ? match : String.fromCharCode(parseInt(hex!, 16)),
  );
}

function backslashesBefore(text: string, at: number): number {
  let count = 0;

  while (text[at - count - 1] === '\\') count++;

  return count;
}

/** an escape inside an escaped backslash is literal text, not a Unicode match. */
function escapedMatch(old: string, content: string): string | undefined {
  if (backslashesBefore(old, old.length) % 2 || !content.includes('\\u'))
    return;

  const escapes = old.startsWith('\\') ? [0] : [];
  let length = 0;
  let pattern = '';

  for (let index = 0; index < old.length; index++) {
    const code = old.charCodeAt(index);

    if (code >= 128) {
      escapes.push(length);
      length += 6;

      pattern +=
        '\\\\u' +
        code
          .toString(16)
          .padStart(4, '0')
          .replace(/[a-f]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
    } else {
      length++;
      pattern += escapeRegExp(old[index]!);
    }
  }

  if (length > content.length) return;

  const regex = new RegExp(pattern, 'g');

  for (let match = regex.exec(content); match; match = regex.exec(content)) {
    if (
      escapes.every(
        (offset) => backslashesBefore(content, match.index + offset) % 2 === 0,
      )
    )
      return content.indexOf(match[0]) === match.index ? match[0] : undefined;

    regex.lastIndex = match.index + 1;
  }
}

function matchedText(content: string, old: string): string | undefined {
  if (content.includes(old)) return old;

  const index = plainQuotes(content).indexOf(plainQuotes(old));

  if (index !== -1) return content.slice(index, index + old.length);

  if (unicodeEscape.test(old)) {
    const decoded = decodeEscapes(old);

    if (decoded !== old && content.includes(decoded)) return decoded;
  }

  if (nonAscii.test(old)) return escapedMatch(old, content);
}

/** the replacement follows the quotes and escape spelling of the actual match. */
function replacementText(
  old: string,
  matched: string,
  replacement: string,
): string {
  if (old === matched) return replacement;

  const doubleQuotes = /[“”]/.test(matched);
  const singleQuotes = /[‘’]/.test(matched);

  replacement = replacement.replace(/["']/g, (quote, index: number) => {
    if (!(quote === '"' ? doubleQuotes : singleQuotes)) return quote;

    const opening =
      index === 0 || ' \t\n\r([{\u2014\u2013'.includes(replacement[index - 1]!);

    return quote === '"' ? (opening ? '“' : '”') : opening ? '‘' : '’';
  });

  if (nonAscii.test(old) && escapedMatch(old, matched) === matched) {
    const spellings = new Map<number, string>();
    let offset = 0;
    let upper = 0;
    let lower = 0;

    for (let index = 0; index < old.length; index++) {
      const code = old.charCodeAt(index);

      if (code >= 128) {
        const hex = matched.slice(offset + 2, offset + 6);
        spellings.set(code, hex);
        upper += hex.match(/[A-F]/g)?.length ?? 0;
        lower += hex.match(/[a-f]/g)?.length ?? 0;
        offset += 6;
      } else offset++;
    }

    return replacement.replace(/[\u0080-\uffff]/g, (letter) => {
      const code = letter.charCodeAt(0);
      const hex = code.toString(16).padStart(4, '0');

      return (
        '\\u' +
        (spellings.get(code) ?? (upper > lower ? hex.toUpperCase() : hex))
      );
    });
  }

  return unicodeEscape.test(old) && decodeEscapes(old) === matched
    ? decodeEscapes(replacement)
    : replacement;
}

function preserveBom(content: string, replacement: string): string {
  return replacement &&
    content.startsWith('\uFEFF') &&
    !replacement.startsWith('\uFEFF')
    ? '\uFEFF' + replacement
    : replacement;
}

/** a local proposal only; native validation, hooks and the eventual write remain native-owned. */
export async function proposedDiff(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal,
): Promise<FileDiff[] | undefined> {
  if (signal.aborted || typeof input.file_path !== 'string') return;

  if (
    tool === 'Write'
      ? typeof input.content !== 'string'
      : tool !== 'Edit' ||
        typeof input.old_string !== 'string' ||
        typeof input.new_string !== 'string' ||
        (input.replace_all !== undefined &&
          typeof input.replace_all !== 'boolean')
  )
    return;

  const path = resolveFile(input.file_path, cwd);

  try {
    let content = '';
    let exists = true;

    try {
      if (!(await fs.stat(path)).isFile()) return;

      const bytes = await fs.readFile(path, { signal });

      if (bytes.includes(0)) return;

      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(bytes)
        .replaceAll('\r\n', '\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;

      exists = false;
    }

    if (signal.aborted) return;

    let next: string;
    let kind: 'add' | 'update' = exists ? 'update' : 'add';

    if (tool === 'Write') next = preserveBom(content, input.content as string);
    else {
      const old = input.old_string as string;
      const replacement = input.new_string as string;

      if (old === '') {
        if (content.trim()) return;

        next = preserveBom(content, replacement);
        kind = 'add';
      } else {
        const matched = matchedText(content, old);

        if (
          matched === undefined ||
          (!input.replace_all &&
            content.indexOf(
              matched,
              content.indexOf(matched) + matched.length,
            ) !== -1)
        )
          return;

        const updated = replacementText(old, matched, replacement);

        const removed =
          updated === '' &&
          !matched.endsWith('\n') &&
          content.includes(matched + '\n')
            ? matched + '\n'
            : matched;

        next = input.replace_all
          ? content.replaceAll(removed, () => updated)
          : content.replace(removed, () => updated);
      }
    }

    if (kind === 'add') return [wholeFile(path, 'add', next)];

    return await new Promise((resolve) => {
      structuredPatch(path, path, content, next, undefined, undefined, {
        context: 3,
        timeout: 5000,
        callback: (patch) =>
          resolve(
            signal.aborted || !patch
              ? undefined
              : [{ path, kind, hunks: patch.hunks }],
          ),
      });
    });
  } catch {
    return undefined;
  }
}
