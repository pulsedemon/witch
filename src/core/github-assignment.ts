import { z } from 'zod';
import { errorMessage } from '../errors.js';
import { runCommand } from './command.js';
import type { TaskClaim } from './coordination-state.js';

/** resolves the references GitHub confirmed and any failure so the caller can warn while retaining ownership. */
export async function assignGitHubTask(
  references: string[],
  cwd: string,
  deadline: number,
): Promise<{ assigned: string[]; failure?: string }> {
  const issues = references.flatMap((reference) => {
    const match = /^github:([^#]+)#(\d+)$/.exec(reference);
    return match
      ? [
          {
            reference,
            endpoint: `repos/${match[1]}/issues/${match[2]}/assignees`,
          },
        ]
      : [];
  });
  if (!issues.length) return { assigned: [] };
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
  let login: string;
  try {
    login = z
      .string()
      .trim()
      .min(1)
      .parse(await request('user', '--jq', '.login'));
  } catch (error) {
    return { assigned: [], failure: errorMessage(error) };
  }
  const assigned: string[] = [];
  const failures: string[] = [];
  for (const { reference, endpoint } of issues) {
    try {
      const assignees = z
        .array(z.string())
        .parse(
          JSON.parse(
            await request(
              endpoint,
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
      assigned.push(reference);
    } catch (error) {
      failures.push(`${endpoint}: ${errorMessage(error)}`);
    }
  }
  return failures.length
    ? { assigned, failure: failures.join('\n') }
    : { assigned };
}

/** assignment failure leaves the local claim intact, including when saving the receipt fails. */
export async function recordTaskAssignment(
  claim: TaskClaim,
  cwd: string,
  deadline: number,
  assign: typeof assignGitHubTask,
  record: (
    id: string,
    references: string[],
    deadline: number,
  ) => Promise<TaskClaim | undefined>,
): Promise<{ claim: TaskClaim; warning?: string }> {
  const { assigned, failure } = await assign(
    claim.references.filter(
      (reference) => !claim.assigned?.includes(reference),
    ),
    cwd,
    deadline - 2000,
  );
  let recorded = claim;
  const warnings = failure
    ? [
        `GitHub assignment failed. The local claim is retained; repeat --claim to retry. ${failure}`,
      ]
    : [];
  if (assigned.length) {
    try {
      recorded = (await record(claim.id, assigned, deadline - 1000)) ?? claim;
    } catch (error) {
      warnings.push(
        `GitHub assignment succeeded, but its local receipt could not be saved. Repeat --claim to retry. ${errorMessage(error)}`,
      );
    }
  }
  return {
    claim: recorded,
    ...(warnings.length ? { warning: warnings.join('\n') } : {}),
  };
}
