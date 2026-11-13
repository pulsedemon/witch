import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseCommand } from '../cli-control.js';
import { lockedFiles } from '../persistence/lock.js';
import {
  processArguments,
  processDirectory,
  processExecutable,
  ps,
} from '../persistence/process.js';
import { unlessGone } from '../persistence/json.js';
import { listParticipants } from '../persistence/runtime-updates.js';

interface RuntimeUser {
  pid: number;
  reason: string;
}

/** old Witch instances can start another runtime even while their current native child is absent. */
export async function runtimeUpdateUsers(
  root: string,
  directory: string,
): Promise<RuntimeUser[]> {
  const held = await lockedFiles(await listParticipants(directory));
  const participating = new Set(
    [...held.keys()].map((file) => Number(basename(file, '.json'))),
  );
  const processes = (
    await ps('pid=,uid=,comm=', undefined, { timeout: 5000 })
  ).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (
      !match ||
      Number(match[2]) !== process.getuid?.() ||
      Number(match[1]) === process.pid
    )
      return [];
    return [{ pid: Number(match[1]), command: match[3]! }];
  });
  const argumentsByPid = await processArguments(
    processes.map((row) => row.pid),
  );
  const candidates = processes.filter(({ pid, command }) =>
    [command, argumentsByPid.get(pid)?.[0]].some(
      (executable) =>
        executable &&
        (executable.startsWith(`${root}/`) ||
          /^(?:node|bun|bash|zsh|sh|curl|codex|claude|MainThread)(?:$|-)/.test(
            basename(executable),
          ) ||
          executable.includes('/claude/versions/')),
    ),
  );
  const rows = (
    await Promise.all(
      candidates.map(async ({ pid, command }) => {
        // Linux comm is a thread name; require executable access only for runtime candidates.
        const executable =
          process.platform === 'linux' ? await processExecutable(pid) : command;
        return executable ? [{ pid, command: executable }] : [];
      }),
    )
  ).flat();
  const users: RuntimeUser[] = [];
  for (const { pid, command } of rows) {
    const args = argumentsByPid.get(pid);
    if (!args) {
      if ((await ps('pid=', [pid])).length)
        users.push({
          pid,
          reason: 'Native process arguments are inaccessible',
        });
      continue;
    }
    if (
      args.some((argument) =>
        argument.includes(`${join(directory, 'operations')}/`),
      )
    ) {
      users.push({
        pid,
        reason: 'A native update installer or helper is still running',
      });
      continue;
    }
    const executable = isAbsolute(command) ? command : args[0];
    if (executable && isAbsolute(executable)) {
      const actual = (await unlessGone(realpath(executable))) ?? executable;
      if (actual.startsWith(`${root}/`)) {
        users.push({ pid, reason: 'Native installation is in use' });
        continue;
      }
    }
    const entry = args.find((argument) =>
      /(?:^|\/)(?:dist\/cli\.js|src\/cli\.tsx)$/.test(argument),
    );
    if (!entry || participating.has(pid)) continue;
    const cwd = isAbsolute(entry)
      ? undefined
      : await processDirectory(pid).catch(() => undefined);
    if (!isAbsolute(entry) && !cwd) {
      if ((await ps('pid=', [pid])).length)
        users.push({
          pid,
          reason: 'Possible Witch instance directory cannot be identified',
        });
      continue;
    }
    const path = isAbsolute(entry) ? entry : resolve(cwd!, entry);
    const metadata = await unlessGone(
      readFile(join(dirname(dirname(path)), 'package.json'), 'utf8'),
    );
    if (metadata === undefined) {
      users.push({
        pid,
        reason: 'Possible Witch instance cannot be identified',
      });
      continue;
    }
    if ((JSON.parse(metadata) as { name?: string }).name !== 'witch') continue;
    try {
      const parsed = parseCommand(args.slice(args.indexOf(entry) + 1));
      if (!parsed.familiar && (parsed.control || parsed.values.help)) continue;
    } catch {
      /* an older CLI with unknown options still needs to close. */
    }
    users.push({
      pid,
      reason: 'Witch instance does not participate in native update admission',
    });
  }
  return users;
}
