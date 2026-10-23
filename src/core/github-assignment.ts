import { z } from 'zod';
import { errorMessage } from '../agents/stderr.js';
import { runCommand } from './command.js';

/** rejects unconfirmed assignments so the caller can warn while retaining ownership. */
export async function assignGitHubTask(
  references: string[],
  cwd: string,
  deadline: number,
): Promise<void> {
  const issues = references.flatMap((reference) => {
    const match = /^github:([^#]+)#(\d+)$/.exec(reference);
    return match ? [`repos/${match[1]}/issues/${match[2]}/assignees`] : [];
  });
  if (!issues.length) return;
  const request = async (endpoint: string, ...args: string[]) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('GitHub assignment deadline expired.');
    const { stdout } = await runCommand(
      'gh',
      ['api', '--hostname', 'github.com', endpoint, ...args],
      { cwd, timeout, killSignal: 'SIGKILL' },
    );
    return stdout;
  };
  const login = z
    .string()
    .trim()
    .min(1)
    .parse(await request('user', '--jq', '.login'));
  const failures: string[] = [];
  for (const issue of issues) {
    try {
      const assignees = z
        .array(z.string())
        .parse(
          JSON.parse(
            await request(
              issue,
              '--method',
              'POST',
              '-f',
              `assignees[]=${login}`,
              '--jq',
              '[.assignees[].login]',
            ),
          ),
        );
      // GitHub can ignore an assignee without failing the request.
      if (
        !assignees.some(
          (assignee) => assignee.toLowerCase() === login.toLowerCase(),
        )
      )
        throw new Error(`GitHub did not confirm assignment to ${login}.`);
    } catch (error) {
      failures.push(`${issue}: ${errorMessage(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
