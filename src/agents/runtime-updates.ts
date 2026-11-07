import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { unlessGone } from '../persistence/json.js';
import type { AgentRegistration } from './registry.js';
import { nativeInstallationRoot } from './executable.js';

const execute = promisify(execFile);
const enabled = (value: string | undefined) =>
  ['1', 'true', 'yes', 'on'].includes(value?.toLowerCase().trim() ?? '');
export const runtimeSchema = z.enum(['claude', 'codex']);
export type NativeRuntime = z.infer<typeof runtimeSchema>;
export const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);

export const installationSchema = z.object({
  runtime: runtimeSchema,
  launcher: z.string(),
  executable: z.string(),
  version: versionSchema,
  digest: z.string(),
  root: z.string(),
  channel: z.enum(['latest', 'stable', 'rc']),
  automatic: z.boolean(),
  blocked: z.string().optional(),
  minimum: z.string().optional(),
  maximum: z.string().optional(),
});
export const runtimeCheckSchema = z.object({
  installation: installationSchema,
  target: versionSchema,
  source: z.string(),
  checkedAt: z.number(),
  available: z.boolean(),
  blocked: z.string().optional(),
});
export type RuntimeInstallation = z.infer<typeof installationSchema>;
export type RuntimeUpdateCheck = z.infer<typeof runtimeCheckSchema>;

export async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function contentDigest(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isFile()) return fileDigest(path);
  if (info.isSymbolicLink())
    return createHash('sha256')
      .update(await readlink(path))
      .digest('hex');
  if (!info.isDirectory())
    throw new Error(`Cannot identify native artifact: ${path}`);
  const hash = createHash('sha256');
  for (const name of (await readdir(path)).sort())
    hash.update(`${name}\0${await contentDigest(join(path, name))}\0`);
  return hash.digest('hex');
}

export async function artifactDigest(
  runtime: NativeRuntime,
  executable: string,
): Promise<string> {
  const release = dirname(dirname(executable));
  const packageFile =
    runtime === 'codex' && basename(dirname(executable)) === 'bin'
      ? await unlessGone(lstat(join(release, 'codex-package.json')))
      : undefined;
  return contentDigest(packageFile?.isFile() ? release : executable);
}

export function compareVersions(left: string, right: string): number {
  const [a, preA] = versionSchema.parse(left).split('-');
  const [b, preB] = versionSchema.parse(right).split('-');
  const parts = b!.split('.').map(Number);
  for (const [index, value] of a!.split('.').map(Number).entries()) {
    const difference = value - parts[index]!;
    if (difference) return difference;
  }
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA.localeCompare(preB, 'en', { numeric: true });
}

export async function inspectRuntime(
  registration: AgentRegistration,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<RuntimeInstallation> {
  const runtime = runtimeSchema.parse(registration.adapter.id);
  if (!registration.executable) throw new Error(`${runtime} is not installed.`);
  const launcher = registration.executable;
  const executable = await realpath(launcher);
  const packageFile =
    runtime === 'codex' && basename(dirname(executable)) === 'bin'
      ? await unlessGone(
          lstat(join(dirname(dirname(executable)), 'codex-package.json')),
        )
      : undefined;
  const detectedRoot = nativeInstallationRoot(executable);
  if (!detectedRoot && !packageFile?.isFile())
    throw new Error(
      `Unsupported installation at ${executable}. Use the native ${runtime} installer for updates through Witch.`,
    );
  const { stdout } = await execute(executable, ['--version'], {
    signal,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
  });
  const version = versionSchema.parse(
    /(?:^|\s)(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\s|$)/.exec(stdout)?.[1],
  );
  const digest = await artifactDigest(runtime, executable);
  if (runtime === 'codex') {
    const root = join(
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      'packages',
      'standalone',
    );
    const release = dirname(dirname(executable));
    const metadata = await unlessGone(
      readFile(join(release, 'codex-package.json'), 'utf8'),
    );
    const installedRoot = await unlessGone(realpath(root));
    const native =
      metadata !== undefined &&
      installedRoot !== undefined &&
      dirname(release) === join(installedRoot, 'releases');
    const automatic = !!(await unlessGone(
      readFile(join(detectedRoot ?? release, 'auto-update-version'), 'utf8'),
    ));
    return {
      runtime,
      launcher,
      executable,
      version,
      digest,
      root: detectedRoot ?? release,
      channel: 'latest',
      automatic,
      ...(!native
        ? {
            blocked:
              'Use OpenAI’s native Codex installer before updating through Witch.',
          }
        : automatic
          ? {
              blocked:
                'Native Codex automatic updates are enabled. Its exact-version installer would disable them; use the native updater to preserve that policy.',
            }
          : {}),
    };
  }
  const root = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
    'claude',
  );
  const installedRoot = await unlessGone(realpath(root));
  const native =
    installedRoot !== undefined &&
    dirname(executable) === join(installedRoot, 'versions') &&
    launcher === join(homedir(), '.local', 'bin', 'claude');
  const { resolveSettings } = await import('@anthropic-ai/claude-agent-sdk');
  const { effective } = await resolveSettings({ cwd });
  const environment = { ...process.env, ...effective.env };
  return {
    runtime,
    launcher,
    executable,
    version,
    digest,
    root: detectedRoot!,
    channel: effective.autoUpdatesChannel ?? 'latest',
    automatic:
      !enabled(environment.DISABLE_AUTOUPDATER) &&
      !enabled(environment.DISABLE_UPDATES) &&
      !environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    minimum: effective.minimumVersion,
    maximum: effective.requiredMaximumVersion,
    ...(!native
      ? {
          blocked:
            'Use the native Claude installation on PATH before updating through Witch.',
        }
      : effective.policyHelper
        ? {
            blocked:
              'Claude update policy uses a native policy helper; update through Claude.',
          }
        : enabled(environment.DISABLE_UPDATES)
          ? { blocked: 'Claude updates are disabled by native settings.' }
          : {}),
  };
}

export async function checkRuntimeUpdate(
  installation: RuntimeInstallation,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<RuntimeUpdateCheck> {
  const source =
    installation.runtime === 'claude'
      ? `https://downloads.claude.ai/claude-code-releases/${installation.channel}`
      : 'https://releases.openai.com/codex/channels/latest';
  const response = await request(source, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok)
    throw new Error(
      `Release check failed: HTTP ${response.status} from ${source}`,
    );
  const target = versionSchema.parse(
    installation.runtime === 'claude'
      ? (await response.text()).trim()
      : z
          .object({ tag_name: z.string() })
          .parse(await response.json())
          .tag_name.replace(/^rust-v/, ''),
  );
  return assessRuntimeUpdate(installation, {
    target,
    source,
    checkedAt: Date.now(),
  });
}

export function assessRuntimeUpdate(
  installation: RuntimeInstallation,
  release: Pick<RuntimeUpdateCheck, 'target' | 'source' | 'checkedAt'>,
): RuntimeUpdateCheck {
  const { target } = release;
  const blocked =
    installation.blocked ??
    (installation.minimum && compareVersions(target, installation.minimum) < 0
      ? `Native minimum version is ${installation.minimum}.`
      : installation.maximum &&
          compareVersions(target, installation.maximum) > 0
        ? `Native maximum version is ${installation.maximum}.`
        : undefined);
  return {
    installation,
    ...release,
    available: compareVersions(target, installation.version) > 0,
    blocked,
  };
}
