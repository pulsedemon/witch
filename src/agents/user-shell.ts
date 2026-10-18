import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';

/** the output Witch keeps of a command, as Codex keeps 1 MiB of its own. */
const keptLength = 1 << 20;
/** the output a record keeps, Claude Code's default `bashOutputMaxChars`. */
const recordLength = 30000;
const cutNote = '\n[output past 1 MiB cut]\n';

export interface ShellRun {
  /** stdout and stderr in arrival order. */
  output: string;
  /** null when a signal ended the shell. */
  code: number | null;
  interrupted: boolean;
}

/** a group holding only the unreaped shell refuses signals with EPERM, and a throw from an abort listener would end Witch. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

/**
 * runs a command the user typed, unsandboxed, in their shell; output streams to `onOutput` as it is kept. the shell
 * gets no login, as Claude Code's own `!` gets none, since a login profile can put another toolchain first on PATH.
 */
export function runShell(
  command: string,
  options: { cwd: string; signal: AbortSignal; onOutput(text: string): void },
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-c', command], {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      if (child.pid) killGroup(child.pid);
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
      if (interrupted && child.pid) killGroup(child.pid);
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

/** the command and its output, modeled on the record Claude Code's `!` writes; exit codes are Witch's addition. */
export function bashRecord(command: string, run: ShellRun): string {
  const output = clip(run.output).replace(/[&<>]/g, (char) => entities[char]!);
  const failed = run.interrupted || run.code !== 0;
  const note = run.interrupted
    ? '[Request interrupted by user]'
    : `Exit code ${run.code ?? 'unknown'}`;
  const stderr = failed
    ? `${output}${output && !output.endsWith('\n') ? '\n' : ''}${note}`
    : '';
  return `<bash-input>${command}</bash-input>\n<bash-stdout>${failed ? '' : output}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}
