import { commands } from './commands.js';

import { accent, colors } from './theme.js';

const heading = (text: string) => colors.hex(accent).bold(text);

/** the /help page, which defines Witch's keys and commands. */
export function helpText(): string {
  const commandList = commands
    .map(
      ({ id, label, aliases = [] }) =>
        `${[id, ...aliases].map((name) => `/${name}`).join(', ')}  ${label}`,
    )
    .join('\n');

  const argumentCommands = commands
    .filter((command) => command.takesArguments)
    .map((command) => `/${command.id}`)
    .join(', ');

  return [
    `${heading('COMMANDS')}\n${commandList}\nA message that starts with a Witch command runs every Witch command in it outside backticks, in order. In a message that starts otherwise, /new, /clear, /restart and /exit (or /quit) stay text and other Witch commands still run; with none left, the message goes to the agent unchanged. Surrounding prose is discarded. ${argumentCommands} take arguments up to the next command. A leading ! or listed native command keeps the whole input unchanged.\n/compact waits for foreground work without interrupting the task. Claude can compact while familiars continue; Codex waits for its active turn to finish. Pending: /compact shows unfinished requests. Prompts wait until compaction, picker choices and model changes finish. A failed or canceled command stops later command batches and lists them for explicit retry.\nCtrl+P opens commands.`,
    `${heading('COMPOSER')}\nEnter sends. Shift+Enter inserts a newline. Pasted newlines never send.\nCmd+←/→ go to the start or end of the wrapped row, and Option+←/→ move by word. Cmd+Delete deletes to the start of the wrapped row, Option+Delete the word before the cursor, and Fn+Option+Delete the word after it. Ctrl+A, Ctrl+E and Ctrl+U work as Cmd+←, Cmd+→ and Cmd+Delete, and Option+B and Option+F as Option+←/→.\nA message that starts with ! runs the rest as a shell command in this directory, without a sandbox, and the agent then replies to it. One sent while the agent works waits until the agent finishes, unless the agent has replied while familiars or workflows still run and nothing but a spell or native command is waiting, when it runs at once.\n↑ on the first line takes queued messages back to edit when merging would not execute Witch commands, or with none queued shows the prompt sent before, from any conversation in this directory. ↓ on the last line goes back to newer prompts and the draft.\nType / for commands and spells, or @ for files. In that list, ↑/↓ choose, Tab completes, Enter runs a command or inserts a file, and Escape closes it.`,
    `${heading('WHILE THE AGENT WORKS')}\nWhile the agent works, Enter passes a message into its turn, or queues it for the next one, which still runs after an ordinary turn is interrupted. A message sent while Witch answers another session's peer requests waits for that answer turn. Escape or Ctrl+C that stops work holds answer turns until your next message, another conversation or /restart, and stopping an answer turn ends automatic answers for its requests. Cancelled or failed compaction leaves queued messages undelivered.\nWith no list open, Escape closes a view, then leaves tool focus, then interrupts execution.\nCtrl+C interrupts active work or cancels a pending question. Idle in the conversation, it clears the composer's text; with nothing to clear it asks for a second press within a second to exit. It quits at once while closing or recovering memory.`,
    `${heading('TOOLS')}\nWith no list open, Tab selects tool results; ↑/↓ choose a tool, Enter expands or collapses it. Ctrl+O switches new or deleted files between their preview and all lines.\nEnd returns to live output while tools are focused.`,
    `${heading('REQUESTS')}\nOn a request, Escape declines it and the turn continues. Ctrl+O switches new or deleted files between their preview and all lines.`,
    `${heading('MOUSE AND SCROLLING')}\nPageUp/PageDown and the mouse wheel scroll.\nClick web links to open your browser.\nClick file paths to open VS Code at their line and column.\nDrag selects transcript text, and Cmd+C copies it.\nShift+drag selects as the terminal does.\nClick a tool's + or − to expand or collapse it.`,
    `${heading('MODELS')}\n/model <id> [effort] selects a model on the active runtime, or hands off to the runtime that lists it when only another runtime does.\n/model <agent>:<id> [effort] selects a runtime and model; choosing another runtime performs a handoff.`,
    `${heading('MEMORY')}\nIn memory: e edits the note in VS Code; h shows its history.\nClose the VS Code file to finish editing and commit its changes.`,
  ].join('\n\n');
}
