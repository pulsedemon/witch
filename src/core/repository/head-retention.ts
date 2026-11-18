import { errorMessage } from '../../errors.js';
import { runCommand } from './command.js';
import { gitHubRepository } from './repository.js';
import type { PullRequest } from './repository.js';

/** forks do not inherit the base repository's head-retention policy. */
export async function headRetention(
  { url, number }: Pick<PullRequest, 'url' | 'number'>,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ defaultBranch: string; deletes: boolean } | undefined> {
  const github = gitHubRepository(url);

  if (!github) return undefined;

  const [owner, name] = github.repository.split('/');

  const { stdout } = await runCommand(
    'gh',
    [
      'api',
      'graphql',
      '--hostname',
      github.host,
      '-f',
      'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { deleteBranchOnMerge defaultBranchRef { name } pullRequest(number: $number) { isCrossRepository } } }',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
      '--jq',
      '.data.repository | .deleteBranchOnMerge, .defaultBranchRef.name, .pullRequest.isCrossRepository',
    ],
    { cwd, timeout: 30_000, ...(signal ? { signal } : {}) },
  ).catch((error: unknown) => {
    if (error === signal?.reason) throw error;

    // the command line carries the whole query, so the error names gh's timeout, stderr or exit code where it has one
    const { stderr, killed, code } = error as {
      stderr?: unknown;
      killed?: unknown;
      code?: unknown;
    };

    throw new Error(
      [killed && 'gh timed out', String(stderr ?? '').trim()]
        .filter(Boolean)
        .join(': ') ||
        (typeof code === 'number'
          ? `gh exited with code ${code}`
          : errorMessage(error)),
      { cause: error },
    );
  });

  const [deletes, base, fork] = stdout.trim().split('\n');

  if (deletes !== 'true' && deletes !== 'false')
    throw new Error(`deleteBranchOnMerge was ${deletes || 'empty'}`);

  if (!base || base === 'null')
    throw new Error('the default branch was missing');

  if (fork !== 'true' && fork !== 'false')
    throw new Error(`isCrossRepository was ${fork || 'empty'}`);

  return fork === 'false'
    ? { defaultBranch: base, deletes: deletes === 'true' }
    : undefined;
}
