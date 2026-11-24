import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeLaunch } from '../native-launch.js';

/**
 * writes the app-server protocol schema, experimental interfaces included, into `directory` and returns the file
 * Witch's committed copy mirrors. empty homes keep the user's Codex configuration out of the output.
 */
export async function generateCodexSchema(
  executable: string,
  directory: string,
): Promise<string> {
  const home = join(directory, 'home');
  const out = join(directory, 'schema');
  await mkdir(home, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    nativeLaunch(executable, (command) =>
      execFile(
        command,
        ['app-server', 'generate-json-schema', '--experimental', '--out', out],
        { env: { ...process.env, HOME: home, CODEX_HOME: home } },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  });

  return join(out, 'codex_app_server_protocol.schemas.json');
}
