import { realpathSync } from 'node:fs';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { shellWords } from './tool-title.js';

const readers = ['cat', 'head', 'tail', 'sed', 'nl', 'bat'];
// the runners and script extensions Codex's own implicit-invocation detector recognizes
const runners = [
  'python',
  'python3',
  'bash',
  'zsh',
  'sh',
  'node',
  'deno',
  'ruby',
  'perl',
  'pwsh',
];
const scripts = ['.py', '.sh', '.js', '.ts', '.rb', '.pl', '.ps1'];

const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), path: z.string() }),
  z.object({ type: z.literal('unknown'), command: z.string() }),
  z.object({ type: z.enum(['listFiles', 'search']) }),
]);
const command = z.object({
  type: z.literal('commandExecution'),
  cwd: z.string(),
  source: z.string().optional(),
  commandActions: z.array(z.unknown()).nullish(),
});
const message = z.object({
  type: z.literal('userMessage'),
  content: z.array(z.unknown()),
});
const skillInput = z.object({
  type: z.literal('skill'),
  name: z.string(),
  path: z.string(),
});

interface SpellCast {
  /** the spell's canonical SKILL.md. */
  path: string;
  name: string;
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** each enabled spell's canonical SKILL.md, first name per path. */
export function castIndex(
  spells: readonly { name: string; path: string }[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const { name, path } of spells) {
    const key = canonical(path);
    if (!index.has(key)) index.set(key, name);
  }
  return index;
}

function operands(words: string[]): string[] {
  return words.slice(1).filter((word) => !word.startsWith('-'));
}

/** the spells an item casts: a selected spell, or a command that reads a SKILL.md or runs one of its scripts. */
export function castSkills(
  item: unknown,
  index: ReadonlyMap<string, string>,
): SpellCast[] {
  const casts = new Map<string, string>();
  const doc = (path: string) => {
    const name = index.get(path);
    if (name !== undefined && !casts.has(path)) casts.set(path, name);
  };
  const selected = message.safeParse(item);
  if (selected.success) {
    for (const entry of selected.data.content) {
      const skill = skillInput.safeParse(entry);
      if (skill.success) casts.set(canonical(skill.data.path), skill.data.name);
    }
  }
  const ran = command.safeParse(item);
  if (ran.success && ran.data.source !== 'userShell') {
    const { cwd } = ran.data;
    const at = (path: string) => canonical(resolve(cwd, path));
    for (const raw of ran.data.commandActions ?? []) {
      const parsed = action.safeParse(raw);
      if (!parsed.success) continue;
      const step = parsed.data;
      if (step.type === 'read') doc(at(step.path));
      if (step.type !== 'unknown') continue;
      const words = shellWords(step.command)?.words ?? [];
      const program = basename(words[0] ?? '');
      if (readers.includes(program))
        for (const word of operands(words)) doc(at(word));
      const script = operands(words)[0];
      if (
        runners.includes(program) &&
        script &&
        scripts.includes(extname(script).toLowerCase())
      ) {
        const path = at(script);
        for (const [spell, name] of index)
          if (path.startsWith(`${dirname(spell)}${sep}scripts${sep}`)) {
            if (!casts.has(spell)) casts.set(spell, name);
            break;
          }
      }
    }
  }
  return [...casts].map(([path, name]) => ({ path, name }));
}
