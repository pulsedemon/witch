#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from './agents/stderr.js';
import { parseCommand, runControl, writeControl } from './cli-control.js';
import { runClaudeFamiliar } from './cli-familiar.js';
import { runCodexFamiliar } from './cli-codex-familiar.js';

const defaultState = join(homedir(), '.witch');
const usage = `Usage: witch [options] [prompt...]

Start a conversation in the current directory on the agent, model and effort
you last used, sending the prompt if one is given.

Options:
  -c, --continue       continue this directory's most recent conversation
  --state-dir <dir>    keep conversations and memory in <dir> (default ${defaultState})
  --recover-directory <old>  preview recovery of a missing directory into this one
  --apply              apply the directory recovery with all Witches closed
  --spawn <n>          create worktrees <checkout>-1 to <checkout>-n beside the main
                       checkout and open a Ghostty tab running witch in each one
                       without an open session
  -h, --help           show this help

Agent control (use the prefix supplied in the current Witch context):
  --peers             list this project's sessions and reservations
  --claim <ref>       claim an issue/pr URL or task:<name>
  --summary <text>    describe the claimed work
  --alias <ref>       add a related reference to the claim
  --release <id>      release this conversation's exact claim
  --select-next <turn> wait for this turn's next-task selection slot
  --recommend <ref>   reserve a recommendation and advance the queue
  --selection <id>    identify the selection for --recommend
  --cancel-selection <id>  leave this turn's queue
  --ask <claim-id>    ask the owner of a claimed task; needs --message
  --answer <id>       answer a peer request; needs --message
  --message <text>    the request or answer text
  --peer-request <id> show a peer request you sent or received
  --pause             pause this project's other sessions
  --to <id>           pause only this session, in any project; repeatable
  --resume <id>       lift a pause this session issued
  --pause-status <id> show a pause's recipients and whether each has stopped
  --route <work>      choose where review, planning, implementation or investigation goes
  --of <runtime>:<model>    the runtime and model whose work a review checks
  --named <runtime>:<model> a model the user or agent named, which runs as named, or a family, at its newest
  --json              print the control result as JSON

Delegated tasks (use the familiar prefix supplied in the current Witch context):
  --familiar-claude <name> --report-file <file> -- <native Claude arguments>
                      report a native Claude task as a familiar
  --familiar-codex <name> --report-file <file> [--without-mcp] -- <native app-server options>
                      report a Codex task as a familiar; read its prompt from stdin; --without-mcp starts it with no MCP server

Every word that starts with - is read as an option, so quote a prompt that
contains one, and put -- before a prompt that starts with -.
Use /help inside the app for controls.
`;

// the restart hands its conversation over here, and no agent or command may inherit it
const handover = {
  conversation: process.env.WITCH_CONVERSATION,
  scratch: process.env.WITCH_SCRATCH,
  jobs: process.env.WITCH_JOBS_RESUME,
};
delete process.env.WITCH_CONVERSATION;
delete process.env.WITCH_SCRATCH;
delete process.env.WITCH_JOBS_RESUME;
let command;
try {
  command = parseCommand();
  const { values, control, familiar, spawn } = command;
  // parseArgs accepts an empty value, which would put state in the project
  if (values['state-dir'] === '')
    throw new Error("Option '--state-dir' needs a directory");
  if (
    !control &&
    !familiar &&
    spawn === undefined &&
    !values.help &&
    values['recover-directory'] === undefined &&
    !(process.stdin.isTTY && process.stdout.isTTY)
  )
    throw new Error('Witch needs an interactive terminal.');
} catch (error) {
  if (process.argv.includes('--json'))
    writeControl({ kind: 'error', message: errorMessage(error) }, true);
  else process.stderr.write(`witch: ${errorMessage(error)}\n`);
  process.exit(1);
}
const { values, control, familiar, spawn } = command;
if (familiar) {
  try {
    const { binding, name, reportFile, args } = familiar;
    process.exitCode =
      familiar.runtime === 'codex'
        ? await runCodexFamiliar(
            binding,
            name,
            reportFile,
            args,
            familiar.withoutMcp,
          )
        : await runClaudeFamiliar(binding, name, reportFile, args);
  } catch (error) {
    process.stderr.write(`witch: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
} else if (control) {
  process.exitCode = await runControl(control);
} else if (values.help) {
  process.stdout.write(usage);
} else if (spawn !== undefined) {
  const { runSpawn } = await import('./spawn.js');
  process.exitCode = await runSpawn(process.cwd(), spawn, defaultState);
} else {
  // React picks its slower development build when loaded without this, and agents inherit the environment, so it lasts only the load
  const production = process.env.NODE_ENV === undefined;
  if (production) process.env.NODE_ENV = 'production';
  const { runWitch } = await import('./witch.js').finally(() => {
    if (production) delete process.env.NODE_ENV;
  });
  await runWitch(
    command,
    resolve(values['state-dir'] ?? defaultState),
    fileURLToPath(import.meta.url),
    handover,
  );
}
