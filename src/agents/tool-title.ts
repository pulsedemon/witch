import { basename } from 'node:path';

/** input fields that say what a call acts on, most telling first. */
const subjects = [
  'description',
  'file_path',
  'notebook_path',
  'pattern',
  'url',
  'query',
  'skill',
  'path',
  'prompt',
];
const paths = new Set(['file_path', 'notebook_path', 'path']);

export interface ToolTitle {
  title: string;
  /** the file path `title` shows, so its row links the path whole. */
  path?: string;
  /** the complete label, including the native name or original command, shown on expansion. */
  expandedTitle?: string;
  singleLine?: true;
}

export type CommandPrefixes = Readonly<{ control: string; familiar: string }>;

/** leaves shell syntax uninterpreted so a script cannot look like one bound call. */
export function shellWords(source: string) {
  const words: string[] = [];
  let at = 0;
  while (at < source.length) {
    while (/[ \t\r]/.test(source[at] ?? '') && at < source.length) at++;
    if (at === source.length || /[\n;&|()<>#]/.test(source[at]!)) break;
    let word = '';
    let quote = '';
    while (at < source.length) {
      const char = source[at]!;
      if (!quote && /[ \t\r\n;&|()<>]/.test(char)) break;
      at++;
      if (char === quote) {
        quote = '';
      } else if (!quote && (char === "'" || char === '"')) {
        quote = char;
      } else if (char === '\\' && quote !== "'") {
        const next = source[at];
        if (next === undefined) return;
        if (quote === '"' && !/["\\$`\n]/.test(next)) word += '\\';
        else {
          at++;
          if (next !== '\n') word += next;
          continue;
        }
      } else if (quote !== "'" && /[$`]/.test(char)) {
        return;
      } else {
        word += char;
      }
    }
    if (quote) return;
    words.push(word);
  }
  return { words, rest: source.slice(at) };
}

function inputOnly(rest: string): boolean {
  const tail = rest.trim();
  if (!tail || tail === ';') return true;
  const heredoc = /^<<(-?)[ \t]*(['"])([^\n]+?)\2[ \t]*\r?\n/.exec(tail);
  if (heredoc) {
    const lines = tail.slice(heredoc[0].length).split('\n');
    const end = lines.findIndex(
      (line) => (heredoc[1] ? line.replace(/^\t+/, '') : line) === heredoc[3],
    );
    return end >= 0 && lines.slice(end + 1).every((line) => !line.trim());
  }
  if (!tail.startsWith('<') || tail.startsWith('<<')) return false;
  const input = shellWords(tail.slice(1).trim());
  return input?.words.length === 1 && !input.rest.trim();
}

const controlActions = new Set([
  'peers',
  'claim',
  'recommend',
  'release',
  'select-next',
  'cancel-selection',
  'route',
]);

/** recognizes the invocation supplied by Witch, without interpreting arbitrary shell scripts. */
export function boundCommandTitle(
  command: string,
  prefixes: CommandPrefixes | undefined,
): ToolTitle | undefined {
  if (!prefixes) return;
  let parsed = shellWords(command.trim());
  if (!parsed) return;
  if (
    parsed.words.length === 3 &&
    ['sh', 'bash', 'zsh'].includes(basename(parsed.words[0]!)) &&
    ['-c', '-lc'].includes(parsed.words[1]!) &&
    !parsed.rest.trim()
  ) {
    parsed = shellWords(parsed.words[2]!.trim());
    if (!parsed) return;
  }
  if (!inputOnly(parsed.rest)) return;
  const { words } = parsed;
  while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? '')) words.shift();
  const starts = [0];
  if (words[0] === 'env') {
    let after = 1;
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[after] ?? '')) after++;
    if (after > 1) starts.push(after);
  }
  for (const [kind, prefix] of Object.entries(prefixes)) {
    const expected = shellWords(prefix)?.words;
    if (!expected?.length) continue;
    const start = starts.find((start) =>
      expected.every((word, i) => words[start + i] === word),
    );
    if (start === undefined) continue;
    let title: string | undefined;
    for (let at = start + expected.length; at < words.length; at++) {
      const argument = words[at]!;
      if (argument === '--') break;
      const option = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argument);
      if (!option) return;
      const name = option[1]!;
      if (
        ['control-dir', 'control-conversation', 'control-activation'].includes(
          name,
        )
      )
        return;
      const value =
        option[2] ??
        (name === 'peers' || name === 'json' ? undefined : words[++at]);
      const action =
        kind === 'control'
          ? controlActions.has(name) && name
          : name === 'familiar-claude'
            ? 'Familiar Claude'
            : name === 'familiar-codex'
              ? 'Familiar Codex'
              : undefined;
      if (!action) continue;
      if (title || (name !== 'peers' && !value)) return;
      title = name === 'peers' ? name : `${action} ${value!}`;
    }
    if (title)
      return {
        title: title.replace(/\s+/g, ' '),
        expandedTitle: command,
        singleLine: true,
      };
  }
  return;
}

/** Witch's names for the Claude tools that run a spell or start a familiar. */
const claudeNames = new Map([
  ['Skill', 'Spell'],
  ['Agent', 'Familiar'],
]);

function firstLine(text: string): string {
  const [first = '', ...rest] = text.trim().split('\n');
  return rest.length ? `${first} …` : first;
}

/** a path under `cwd` relative to it, which keeps rows short, after `./` so a bare or extensionless name still links. */
export function shortPath(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? `./${path.slice(cwd.length + 1)}` : path;
}

/** a tool's name, what it acts on, then any shell command, so a collapsed row says what the call does. */
export function toolTitle(
  name: string,
  input: unknown,
  cwd: string,
): ToolTitle {
  if (!input || typeof input !== 'object') return { title: name };
  const fields = input as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? firstLine(value) : undefined;
  const key = subjects.find((key) => text(fields[key]));
  const subject = key && shortPath(text(fields[key])!, cwd);
  const command = text(fields.command);
  return {
    title: [name, subject, command && `$ ${command}`]
      .filter(Boolean)
      .join('  '),
    ...(key && paths.has(key) ? { path: subject } : {}),
  };
}

/** a Claude tool's title under Witch's name for it, where it has one. */
export function claudeTitle(
  name: string,
  input: unknown,
  cwd: string,
  prefixes?: CommandPrefixes,
): ToolTitle {
  if (
    name === 'Bash' &&
    input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string'
  ) {
    const bound = boundCommandTitle(input.command, prefixes);
    if (bound) return { ...bound, expandedTitle: `Bash  $ ${input.command}` };
  }
  const witch = claudeNames.get(name);
  if (!witch) return toolTitle(name, input, cwd);
  return {
    ...toolTitle(witch, input, cwd),
    expandedTitle: toolTitle(`${witch} (${name})`, input, cwd).title,
  };
}
