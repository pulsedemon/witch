import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gone, unlessGone } from '../persistence/json.js';
import { signalGroup } from './shutdown.js';
import { versionSchema } from './runtime-updates.js';
import type { RuntimeInstallation } from './runtime-updates.js';
import { nativeInstallationRoot } from './executable.js';

// exact selection, retention and noninteractive cleanup were checked against this installer revision.
const codexInstallerDigest =
  '44ac252c1b9a68c02bdf0de8e1c6cbfde36fc1afa8684624962eae7d4c461e70';

/** the native install command also removes legacy installs and aliases, which an ordinary update must preserve. */
async function checkClaudeCleanup(): Promise<void> {
  if (await unlessGone(lstat(join(homedir(), '.claude', 'local'))))
    throw new Error(
      'A legacy Claude installation needs manual cleanup before Witch can update the native installation.',
    );
  for (const file of [
    join(process.env.ZDOTDIR || homedir(), '.zshrc'),
    ...[
      '.bashrc',
      '.bash_profile',
      '.bash_login',
      '.profile',
      '.config/fish/config.fish',
    ].map((file) => join(homedir(), file)),
  ]) {
    const content = await unlessGone(readFile(file, 'utf8'));
    if (content && /^\s*alias\s+claude\s*=/m.test(content))
      throw new Error(
        `The native Claude installer would edit ${file}. Update Claude manually or remove that alias first.`,
      );
  }
}

export async function installNative(
  installation: RuntimeInstallation,
  target: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  versionSchema.parse(target);
  if (installation.blocked) throw new Error(installation.blocked);
  const launcher = await unlessGone(lstat(installation.launcher));
  if (launcher) {
    let selected: string | undefined;
    try {
      selected = nativeInstallationRoot(installation.launcher);
    } catch (error) {
      if (!gone(error) || !launcher.isSymbolicLink()) throw error;
      const selectedPath = resolve(
        dirname(installation.launcher),
        await readlink(installation.launcher),
      );
      if (selectedPath.startsWith(`${installation.root}/`))
        selected = installation.root;
    }
    if (selected !== installation.root)
      throw new Error(
        'The launcher no longer selects the installation approved for this update.',
      );
  }
  const temporary = join(directory, 'tmp');
  const bin = join(directory, 'bin');
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const mktemp = join(bin, 'mktemp');
  await writeFile(
    mktemp,
    '#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "-d" ]; then\n  exec /usr/bin/mktemp -d -p "$TMPDIR"\nfi\nexec /usr/bin/mktemp "$@"\n',
    { mode: 0o700 },
  );
  await chmod(mktemp, 0o700);
  let args: string[];
  if (installation.runtime === 'claude') {
    await checkClaudeCleanup();
    args = [
      installation.executable,
      '--settings',
      '{"disableAllHooks":true}',
      'install',
      target,
      // installing the running version otherwise skips launcher reselection.
      ...(target === installation.version ? ['--force'] : []),
    ];
  } else {
    const file = join(directory, `codex-install-${codexInstallerDigest}.sh`);
    let source = await unlessGone(readFile(file, 'utf8'));
    if (source === undefined) {
      const response = await fetch('https://chatgpt.com/codex/install.sh', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok)
        throw new Error(
          `Codex installer download failed: HTTP ${response.status}`,
        );
      source = await response.text();
      const digest = createHash('sha256').update(source).digest('hex');
      await writeFile(join(directory, `codex-install-${digest}.sh`), source, {
        mode: 0o600,
      });
    }
    if (
      createHash('sha256').update(source).digest('hex') !== codexInstallerDigest
    )
      throw new Error(
        'The native Codex installer changed. Update Witch before using this installer revision.',
      );
    args = ['/bin/sh', file, '--release', target];
  }
  signal.throwIfAborted();
  const log = join(directory, `${installation.runtime}-${target}-install.log`);
  const stopping = AbortSignal.any([signal, AbortSignal.timeout(6 * 60_000)]);
  const output = await open(log, 'a', 0o600);
  let interrupted = false;
  let code: number | null;
  try {
    stopping.throwIfAborted();
    const child = spawn(args[0]!, args.slice(1), {
      cwd: directory,
      detached: true,
      stdio: ['ignore', output.fd, output.fd],
      env: {
        ...process.env,
        PATH: [
          bin,
          ...(installation.runtime === 'codex'
            ? [dirname(installation.launcher)]
            : []),
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(':'),
        TMPDIR: temporary,
        CLAUDE_CODE_TMPDIR: temporary,
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        CODEX_NON_INTERACTIVE: '1',
        CODEX_INSTALL_DIR: dirname(installation.launcher),
        ...(installation.runtime === 'codex'
          ? { CODEX_HOME: dirname(dirname(installation.root)) }
          : { XDG_DATA_HOME: dirname(installation.root) }),
        CODEX_INSTALL_DAEMON_ONLY: '0',
        CODEX_INSTALL_DEFER_SELECTION: '0',
        CODEX_INSTALL_IF_LATEST: '0',
        CODEX_INSTALL_IF_CURRENT: '0',
        CODEX_UPDATE_FROM_RELEASE: '',
      },
    });
    const stop = () => {
      interrupted = true;
      if (child.pid) signalGroup(child.pid, 'SIGKILL');
    };
    code = await new Promise<number | null>((resolve, reject) => {
      stopping.addEventListener('abort', stop, { once: true });
      child.once('error', (error) => {
        stopping.removeEventListener('abort', stop);
        reject(error);
      });
      child.once('exit', (code) => {
        stopping.removeEventListener('abort', stop);
        if (interrupted && child.pid) signalGroup(child.pid, 'SIGKILL');
        resolve(code);
      });
      if (stopping.aborted) stop();
    });
  } finally {
    await output.close();
  }
  if (interrupted || code !== 0) {
    const output = await unlessGone(readFile(log, 'utf8'));
    throw new Error(`${installation.runtime} installation ${interrupted ? 'was interrupted' : `exited ${code}`}.
${output?.slice(-4096) ?? ''}
Installer log: ${log}`);
  }
}
