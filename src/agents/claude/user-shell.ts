import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { signalGroup } from '../shutdown.js';

/** the output Witch keeps of a command, as Codex keeps 1 MiB of its own. */
const keptLength = 1 << 20;
/** the output a record keeps, Claude Code's default `bashOutputMaxChars`. */
const recordLength = 30000;
const cutNote = '\n[output past 1 MiB cut]\n';

interface ShellRun {
  /** stdout and stderr in arrival order. */
  output: string;
  /** null when a signal ended the shell. */
  code: number | null;
  interrupted: boolean;
}

/**
 * runs a command the user typed, unsandboxed, in their shell; output streams to `onOutput` as it is kept. the shell
 * gets no login, as Claude Code's own `!` gets none, since a login profile can put another toolchain first on PATH.
 */
export function runShell(
  command: string,
  options: {
    cwd: string;
    /** entries added to Witch's environment. */
    env?: Record<string, string>;
    signal: AbortSignal;
    onOutput(text: string): void;

    /** gets the shell's pid, which is its group's id. */
    onSpawn?(pid: number): void;
  },
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-c', command], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) options.onSpawn?.(child.pid);

    let output = '';
    let cut = false;
    let code: number | null = null;
    let interrupted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const receive = (text: string) => {
      if (cut) return;

      const room = keptLength - output.length;
      cut = text.length > room;
      const kept = cut ? text.slice(0, room) + cutNote : text;
      output += kept;
      options.onOutput(kept);
    };

    const interrupt = () => {
      interrupted = true;

      if (child.pid) signalGroup(child.pid, 'SIGKILL');
    };

    // a background child can hold the pipes long after the shell exits, so its later output is drained and dropped
    const settle = (end: () => void) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      // the pid can be reused once the shell is reaped
      options.signal.removeEventListener('abort', interrupt);

      for (const stream of [child.stdout, child.stderr]) {
        stream.off('data', receive);
        (stream as Socket).unref();
      }

      end();
    };

    const done = () => settle(() => resolve({ output, code, interrupted }));

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', receive);
    }

    options.signal.addEventListener('abort', interrupt, { once: true });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', done);

    child.once('exit', (exitCode) => {
      code = exitCode;

      // a child forked as the first kill landed isn't signaled, and keeps the group's id
      if (interrupted && child.pid) signalGroup(child.pid, 'SIGKILL');

      timer = setTimeout(done, 100);
    });
  });
}

/** keeps the start and the end of a long output, since a test log's failures come last. */
function clip(text: string): string {
  if (text.length <= recordLength) return text;

  const half = recordLength / 2;

  return `${text.slice(0, half)}\n[${text.length - recordLength} characters cut]\n${text.slice(-half)}`;
}

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

export const shellFailed = (run: ShellRun) => run.interrupted || run.code !== 0;

/** the command and its output, modeled on the record Claude Code's `!` writes; exit codes are Witch's addition. */
export function bashRecord(command: string, run: ShellRun): string {
  const output = clip(run.output).replace(/[&<>]/g, (char) => entities[char]!);
  const failed = shellFailed(run);

  const note = run.interrupted
    ? '[Request interrupted by user]'
    : `Exit code ${run.code ?? 'unknown'}`;

  const stderr = failed
    ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}${note}`
    : '';

  return `<bash-input>${command}</bash-input>\n<bash-stdout>${failed ? '' : output}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}
