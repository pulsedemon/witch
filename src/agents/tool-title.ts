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
}

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
