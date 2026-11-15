import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** as VS Code's own launcher does: Electron runs cli.js as Node, and Witch's Node options pass under VS Code's names. */
export function editorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_OPTIONS, NODE_REPL_EXTERNAL_MODULE, ...environment } = env;
  // VS Code can outlive the scratch directory TMPDIR names
  delete environment.TMPDIR;

  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_NODE_OPTIONS: NODE_OPTIONS,
    VSCODE_NODE_REPL_EXTERNAL_MODULE: NODE_REPL_EXTERNAL_MODULE,
  };
}

export async function editInVSCode(
  file: string,
  signal: AbortSignal,
): Promise<void> {
  const application = '/Applications/Visual Studio Code.app/Contents';

  await execute(
    join(application, 'MacOS/Code'),
    [join(application, 'Resources/app/out/cli.js'), '--wait', file],
    { signal, env: editorEnvironment(process.env) },
  );
}
