import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { lstat, mkdir, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import type { NativeRuntime } from './runtime-updates.js';
import type { AgentAdapter } from './types.js';
import { unlessGone } from '../persistence/json.js';
import { withoutModelPins } from './claude-side.js';

export type VerificationLaunch = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => ChildProcessWithoutNullStreams;

const launch: VerificationLaunch = (command, args, cwd, env, signal) =>
  spawn(command, args, { cwd, env, signal, stdio: 'pipe' });

/** credentials stay in the native store; only synthetic sessions and settings live in this directory. */
export async function verificationAdapter(
  runtime: NativeRuntime,
  directory: string,
  {
    start = launch,
    mcp,
    ordinarySettings = false,
  }: {
    start?: VerificationLaunch;
    mcp?: { command: string; args: string[] };
    ordinarySettings?: boolean;
  } = {},
): Promise<AgentAdapter> {
  const config = join(directory, 'config');

  const temporary = join(directory, 'tmp');

  await mkdir(config, { recursive: true, mode: 0o700 });

  await mkdir(temporary, { recursive: true, mode: 0o700 });

  if (runtime === 'codex') {
    const auth = join(config, 'auth.json');

    if ((await unlessGone(lstat(auth))) === undefined)
      await symlink(
        join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
        auth,
      );
  }

  const controls = {
    TMPDIR: temporary,
    CLAUDE_CODE_TMPDIR: temporary,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    CODEX_HOME: config,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };

  const env = { ...process.env, ...controls };

  const recorded: VerificationLaunch = (
    command,
    args,
    cwd,
    environment,
    signal,
  ) => {
    appendFileSync(
      join(directory, 'launches.jsonl'),
      `${JSON.stringify({ command, args, cwd, controls })}\n`,
      { mode: 0o600 },
    );

    return start(command, args, cwd, withoutModelPins(environment), signal);
  };

  return runtime === 'codex'
    ? new CodexAdapter((executable, cwd, signal) =>
        recorded(
          executable,
          [
            'app-server',
            '--stdio',
            '-c',
            'approval_policy="on-request"',
            '-c',
            'approvals_reviewer="user"',
            '-c',
            'sandbox_mode="read-only"',
            '-c',
            'features.apps=false',
            '-c',
            'features.plugins=false',
            '-c',
            'features.skill_mcp_dependency_install=false',
            '-c',
            'features.hooks=false',
            '-c',
            'notify=[]',
            '-c',
            'mcp_servers={}',
            ...(mcp
              ? [
                  '-c',
                  `mcp_servers.native_probe.command=${JSON.stringify(mcp.command)}`,
                  '-c',
                  `mcp_servers.native_probe.args=${JSON.stringify(mcp.args)}`,
                ]
              : []),
          ],
          cwd,
          env,
          signal,
        ),
      )
    : new ClaudeAdapter((options) =>
        recorded(
          options.command,
          [
            ...options.args.filter(
              (argument) =>
                ordinarySettings || !argument.startsWith('--setting-sources='),
            ),
            ...(mcp && !options.args.includes('--strict-mcp-config')
              ? [
                  '--mcp-config',
                  JSON.stringify({ mcpServers: { native_probe: mcp } }),
                ]
              : []),
            ...(!ordinarySettings ? ['--setting-sources=project'] : []),
            '--strict-mcp-config',
            '--permission-mode=default',
            '--settings',
            '{"disableAllHooks":true}',
          ],
          options.cwd!,
          { ...env, ...options.env, ...controls },
          options.signal,
        ),
      );
}
