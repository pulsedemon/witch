import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** an executable regular file, checked at the path as given. */
export function launchable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;

    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

const witchRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);

/**
 * the native binary bundled with Witch's pinned dependency, or the `WITCH_<RUNTIME>_EXECUTABLE` override when set.
 * the path keeps `..` after pnpm's package link so it names the installed version at each launch; launch its
 * `realpathSync.native`, since Codex started through the `..` fails its turns. `path.join` would collapse the `..`.
 */
export function nativeExecutable(
  runtime: string,
  {
    environment = process.env,
    root = witchRoot,
  }: { environment?: NodeJS.ProcessEnv; root?: string } = {},
): string | undefined {
  const override = environment[`WITCH_${runtime.toUpperCase()}_EXECUTABLE`];

  if (override !== undefined)
    return launchable(override) ? override : undefined;

  const platform = `${process.platform}-${process.arch}`;
  let path: string;

  if (runtime === 'claude')
    path = `${root}/node_modules/@anthropic-ai/claude-agent-sdk/../claude-agent-sdk-${platform}/claude`;
  else if (runtime === 'codex') {
    const vendor = `${root}/node_modules/@openai/codex/../codex-${platform}/vendor`;
    let triples: string[];

    try {
      triples = readdirSync(vendor);
    } catch {
      return undefined;
    }

    if (triples.length !== 1) return undefined;

    path = `${vendor}/${triples[0]}/bin/codex`;
  } else return undefined;

  return launchable(path) ? path : undefined;
}
