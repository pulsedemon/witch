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

function firstLine(text: string): string {
  const [first = '', ...rest] = text.trim().split('\n');
  return rest.length ? `${first} …` : first;
}

/**
 * a tool's name, what it acts on, then any shell command, so a collapsed row says what the call does. a path
 * under `cwd` shows relative to it to keep rows short, after `./` so a bare or extensionless name still links.
 */
export function toolTitle(name: string, input: unknown, cwd: string): string {
  if (!input || typeof input !== 'object') return name;
  const fields = input as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? firstLine(value) : undefined;
  const subject = subjects.map((key) => text(fields[key])).find(Boolean);
  const command = text(fields.command);
  return [
    name,
    subject?.startsWith(`${cwd}/`)
      ? `./${subject.slice(cwd.length + 1)}`
      : subject,
    command && `$ ${command}`,
  ]
    .filter(Boolean)
    .join('  ');
}
