import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { getSystemErrorName, promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const nativeLocks =
  process.platform === 'linux' ? await import('fs-ext') : undefined;
// paths arrive NUL-terminated and states leave space-separated: loading JSON::PP more than doubled each query's startup
const query = `
use Fcntl qw(F_GETLK F_RDLCK F_WRLCK F_UNLCK SEEK_SET);
my @paths = do { local $/ = "\\0"; map { chomp; $_ } <STDIN> };
my @results;
for my $path (@paths) {
  my $file;
  if (!open($file, '<', $path)) {
    push @results, ($!{ENOENT} || $!{ENOTDIR}) ? 0 : -int($!);
    next;
  }
  my $lock = pack('q q i s s', 0, 0, 0, F_WRLCK, SEEK_SET);
  push @results, fcntl($file, F_GETLK, $lock)
    ? ((unpack('q q i s s', $lock))[3] == F_UNLCK ? 0
      : (unpack('q q i s s', $lock))[3] == F_RDLCK ? 1 : 2)
    : -int($!);
  close($file) or die "Cannot close lock: $!";
}
print join(' ', @results);
`;

const linuxQuery = `
my @paths = do { local $/ = "\\0"; map { chomp; $_ } <STDIN> };
my @files;
my @results;
for my $path (@paths) {
  my $file;
  if (!open($file, '<', $path)) {
    push @results, ($!{ENOENT} || $!{ENOTDIR}) ? 0 : -int($!);
    push @files, undef;
    next;
  }
  push @files, $file;
  push @results, 0;
}
open(my $table, '<', '/proc/locks') or die "Cannot inspect locks: $!";
my %locks;
while (my $line = <$table>) {
  if ($line =~ /^\\d+:\\s+FLOCK\\s+ADVISORY\\s+(READ|WRITE)\\s+\\d+\\s+([0-9a-f]+):([0-9a-f]+):(\\d+)\\s+0\\s+EOF\\s*$/) {
    $locks{join(':', hex($2), hex($3), $4)} = $1 eq 'READ' ? 1 : 2;
  }
}
close($table) or die "Cannot close lock table: $!";
for my $index (0 .. $#files) {
  next unless $files[$index];
  my @stat = stat($files[$index]);
  if (!@stat) { $results[$index] = -int($!); next; }
  my $device = $stat[0];
  my $major = (($device >> 8) & 0xfff) | (($device >> 32) & 0xfffff000);
  my $minor = ($device & 0xff) | (($device >> 12) & 0xffffff00);
  $results[$index] = $locks{join(':', $major, $minor, $stat[1])} // 0;
}
for my $file (@files) {
  next unless $file;
  close($file) or die "Cannot close lock: $!";
}
print join(' ', @results);
`;

// macOS flock flags, which Node doesn't export
const sharedLock = 0x10;
const exclusiveLock = 0x20;

/** the descriptor owns the lock until close; Darwin acquires it atomically with open. */
export async function openLocked(
  file: string,
  flags: number,
  options: { shared?: boolean; mode?: number } = {},
): Promise<FileHandle> {
  const handle = await open(
    file,
    nativeLocks ? flags : flags | (options.shared ? sharedLock : exclusiveLock),
    options.mode,
  );
  if (nativeLocks) {
    try {
      const mode = options.shared ? 'sh' : 'ex';
      await new Promise<void>((resolve, reject) => {
        nativeLocks.flock(
          handle.fd,
          flags & constants.O_NONBLOCK ? `${mode}nb` : mode,
          (error) => (error ? reject(error) : resolve()),
        );
      });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  return handle;
}

/** undefined while another descriptor holds a conflicting lock. */
export async function tryOpenLocked(
  file: string,
  flags: number,
  options: { shared?: boolean; mode?: number } = {},
): Promise<FileHandle | undefined> {
  return openLocked(file, flags | constants.O_NONBLOCK, options).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      return undefined;
    },
  );
}

/** observes kernel lock records without competing with a concurrent acquisition. */
export async function lockedFiles(
  files: readonly string[],
  options: { timeout?: number } = {},
): Promise<Map<string, 'shared' | 'exclusive'>> {
  if (!files.length) return new Map();
  const result = execute(
    '/usr/bin/perl',
    ['-e', nativeLocks ? linuxQuery : query],
    { ...options, killSignal: 'SIGKILL' },
  );
  // report the process failure even when stdin also fails with EPIPE.
  result.child.stdin?.on('error', () => {}).end(`${files.join('\0')}\0`);
  const { stdout } = await result;
  const states = z
    .array(
      z
        .string()
        .regex(/^-?\d+$/)
        .transform(Number)
        .pipe(z.number().max(2)),
    )
    .length(files.length)
    .parse(stdout.split(' '));
  const locked = new Map<string, 'shared' | 'exclusive'>();
  for (const [index, state] of states.entries()) {
    const file = files[index]!;
    if (state < 0) {
      const code = getSystemErrorName(state);
      throw Object.assign(
        new Error(`${code}: Could not inspect lock ${file}`),
        {
          code,
          path: file,
        },
      );
    }
    if (state > 0) locked.set(file, state === 1 ? 'shared' : 'exclusive');
  }
  return locked;
}
