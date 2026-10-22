import { execFile } from 'node:child_process';
import { getSystemErrorName, promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const query = `
use Fcntl qw(F_GETLK F_RDLCK F_WRLCK F_UNLCK SEEK_SET);
use JSON::PP;
my $paths = decode_json(do { local $/; <STDIN> });
my @results;
for my $path (@$paths) {
  my $file;
  if (!open($file, '<', $path)) {
    push @results, $!{ENOENT} ? 0 : -int($!);
    next;
  }
  my $lock = pack('q q i s s', 0, 0, 0, F_WRLCK, SEEK_SET);
  push @results, fcntl($file, F_GETLK, $lock)
    ? ((unpack('q q i s s', $lock))[3] == F_UNLCK ? 0
      : (unpack('q q i s s', $lock))[3] == F_RDLCK ? 1 : 2)
    : -int($!);
  close($file) or die "Cannot close lock: $!";
}
print encode_json([@results]);
`;

// macOS flock flags, which Node doesn't export
export const sharedLock = 0x10;
export const exclusiveLock = 0x20;

/** F_GETLK observes flock ownership without competing with a concurrent open. */
export async function lockedFiles(
  files: readonly string[],
): Promise<Map<string, 'shared' | 'exclusive'>> {
  if (!files.length) return new Map();
  const result = execute('/usr/bin/perl', ['-e', query]);
  // report the process failure even when stdin also fails with EPIPE.
  result.child.stdin?.on('error', () => {}).end(JSON.stringify(files));
  const { stdout } = await result;
  const states = z
    .array(z.number().int().max(2))
    .length(files.length)
    .parse(JSON.parse(stdout));
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

export async function isLocked(file: string): Promise<boolean> {
  return (await lockedFiles([file])).has(file);
}
