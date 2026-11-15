import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);

export function configureGitEnvironment() {
  // a developer's own ssh command would take the place of the ssh test's stand-in
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.GIT_SSH;
  delete process.env.GIT_SSH_COMMAND;
}
