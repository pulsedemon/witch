import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
export const runtimeSchema = z.enum(['claude', 'codex']);

export type NativeRuntime = z.infer<typeof runtimeSchema>;

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);

/** a native binary at its real path, as the check launches it. */
export interface NativeArtifact {
  runtime: NativeRuntime;
  executable: string;
  version: string;
  digest: string;
}

export async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) hash.update(chunk);

  return hash.digest('hex');
}

export async function inspectArtifact(
  runtime: NativeRuntime,
  path: string,
  signal?: AbortSignal,
): Promise<NativeArtifact> {
  const executable = await realpath(path);

  const { stdout } = await execute(executable, ['--version'], {
    signal,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
  });

  const version = versionSchema.parse(
    /(?:^|\s)(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\s|$)/.exec(stdout)?.[1],
  );

  return { runtime, executable, version, digest: await fileDigest(executable) };
}
