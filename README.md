# Witch

A personal terminal app for installed Codex and Claude Code, with Git-backed shared memory.

## Status

Witch is my personal tool, published as is. You are welcome to use it, read it and send changes. I make no promises: no support, no roadmap, and no guarantee that an issue or pull request gets a reply.

Witch drives the Codex and Claude Code CLIs you install and sign in to yourself, under your own accounts and each vendor's terms. It relies on experimental native interfaces, listed under [Development](#development), so a native CLI update can break it.

## Install

Install Node.js (the version in `package.json` `engines`), pnpm, Git 2.43 or newer and the native agent CLIs. Sign in through each native CLI. VS Code handles file links other than images and memory editing, and a signed-in `gh` adds the branch's pull request to the status line, or one whose branch the checkout left while the checked-out branch has none, and lets Witch clean up after it merges.

Lock observation requires macOS's `/usr/bin/perl` with its core `Fcntl` module. Installing the native dependency requires Python 3 and Xcode Command Line Tools.

```sh
pnpm install && pnpm build && pnpm install:cli
```

Rerun `pnpm build` after changes, and `/restart` loads the new build into a running Witch's conversation. When a built Witch finishes cleaning up after a merge into Witch's own repository, it also pulls and rebuilds this checkout, if this one sits on the base branch with nothing staged, modified or conflicted. If another Witch is rebuilding this checkout, the conversation waits for and reports that rebuild's result. Other checkout work skips the refresh with a notice.

On macOS the installed launcher follows the Witch checkout when it moves on the same volume. After a copy to another volume, or a remount that renumbers the volume, it names its missing target; run `pnpm build && pnpm install:cli` from the new checkout to repair it. A launcher installed before this behavior keeps following only its recorded path until `pnpm install:cli` runs once.

## Usage

```sh
cd project && witch
```

Flags and the state default are in `witch --help`. Use `/help` for keyboard controls and `Ctrl+P` for commands.

[Witch commands and compaction](docs/rules.md#witch-commands-and-compaction) describe command sequences, quoted command names and compaction during work.

Other Witch sessions and exclusive task claims are described under [session coordination](docs/rules.md#session-coordination).

Agents delegate work through the [familiar reporting path](docs/rules.md#native-adapters-and-execution) on either runtime, with native identity, activity and a saved report. `/delegation` configures work placement, model families and the coordinator reserve threshold.

`/updates` shows native CLI versions and available releases; `/updates check` refreshes them. `/updates claude` or `/updates codex` opens confirmation for an update, a recovery or qualifying the installed version. [Native runtime updates](docs/rules.md#native-runtime-updates) defines supported installations, live-check consent and recovery.

Witch repairs a directory moved on the same volume on its own the next time it starts there or anywhere else: its conversations, prompt history, spawned worktrees' Git links and shared-memory paths. For a move it can't prove, such as a copy to another volume, its startup notice gives the `--recover-directory` command to run from the new location.

Witch names each tab by its current task and repeats notifications while a request, memory recovery or fatal error waits for you. A successful settled turn gets one notification. [Terminal attention](src/ui/terminal/terminal.ts) owns eligibility and title selection. [Desktop scheduling](src/persistence/notifications.ts) spaces alerts across sessions sharing a state directory; bursts can wait, and stale alerts cancel. Titles and bells keep their timing.

Ghostty controls banners, sound and dock attention. It suppresses notifications for its focused tab in the active window; macOS notification permission and Focus settings also apply. Other state directories and unrelated programs can still collide with Witch's sends. Terminal buffering or a crash between output and schedule persistence can also defeat spacing. Manual tab titles can override Witch's title, and notification forwarding through tmux is not guaranteed.

Keep the memory repository local or back it up yourself; the app never pushes it. Conversations retain native session IDs, so native session storage must remain available for resume.

The lifecycle, recovery rules and scope are defined in the [rules](docs/rules.md).

## Development

Checks run on macOS or Ubuntu 24.04 ARM without a native agent login. Witch remains a macOS application. Use the Node version in [.nvmrc](.nvmrc); [package.json](package.json) pins pnpm and owns the development scripts. On macOS, install the [native build prerequisites](#install). On Ubuntu, install `build-essential`, `python3`, `git`, `perl`, `procps`, `zsh` and `lsof`.

Run checks as an ordinary user so permission assertions remain effective. Linux needs `/proc` mounted in the same PID namespace as the test processes. Give Linux containers an init process, such as Docker's `--init`, to reap orphaned test children. With nvm, run from the repository root:

```sh
nvm install
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm check
```

Installing dependencies enables the [pre-commit hook](.husky/pre-commit), which runs the lint checks defined in [package.json](package.json). Fix reported errors, or run `pnpm format` for formatting, and retry the commit. The [ci workflow](.github/workflows/ci.yml) runs the complete `pnpm check` on Linux.

`pnpm check` also builds `dist`. Agents validating a checkout installed as `witch` must use a disposable copy unless an installed rebuild is authorized. Keep `TMPDIR` outside that copy so fixtures that model non-repositories do not inherit its Git identity. Running the app and native checks requires the [installation prerequisites](#install).

The CLI tests, the [desktop CLI test](test/cli/cli-desktop.test.ts) included, share one build per run through the same [build script](scripts/build.mjs), so the desktop test's startup deadline measures the compiled executable.

`pnpm test` runs the suite with Vitest. [vitest.config.ts](vitest.config.ts) owns discovery, worker policy, global setup and the React compiler transform.

Run a file or one of its named tests with Vitest:

```sh
pnpm exec vitest run test/memory/memory.test.ts
pnpm exec vitest run test/core/coordinator/coordinator-session.test.ts -t 'completion in a later turn'
pnpm exec vitest run test/core/coordinator/coordinator-turns.test.ts -t '^pending command context waits until a prompt is dispatched > turn: connect$'
```

Watch a selected file, or pause its worker for a source debugger:

```sh
pnpm exec vitest --watch test/agents/codex/rpc.test.ts --clearScreen=false
pnpm exec vitest run test/agents/codex/rpc.test.ts --inspect-brk=127.0.0.1:9229 --no-file-parallelism --testTimeout=0 --hookTimeout=0
```

Fixture edits rerun the selected watch set, including fixtures loaded only by spawned children. Press `q` to quit watch mode. Attach a Node Inspector client to the printed address to set TypeScript source breakpoints and inspect locals, then resume execution. The timeout flags turn off the configured test and hook timeouts, which keep counting while a breakpoint pauses the worker.

Confirm before running `pnpm test:integration`: it runs real turns with your native logins and spends account usage. Set `WITCH_CODEX_MODEL` to choose its Codex model.

`pnpm test:integration:codex-brews` checks native child brews with the installed Codex and a localhost model fixture, without account usage, and retains its evidence under `TMPDIR`.

For native macOS verification, run `pnpm check` locally to exercise Darwin locks, boot/process identity and real `sips` conversion. Linux uses a fixture at the `sips` command boundary. The desktop CLI test uses command fixtures for link opening and clipboard writes on both platforms; actual desktop operations remain manual checks.

Then run both scratch-lifetime checks below. They use fixture agents and private tmux sessions with no account usage, and verify scratch retention, reclamation and uncertainty after exit and repeated `/restart`. They require Python 3, tmux and a writable `TMPDIR` short enough for a tmux socket, and wait through a maintenance interval. Use `--case` to select a scenario. Evidence is retained under `TMPDIR`; inspect it and the recorded processes before removing it.

```sh
python3 scripts/check-scratch-lifetime.py "$PWD/src/cli.ts"
python3 scripts/check-scratch-lifetime.py "$PWD/dist/cli.js"
```

To add another installed agent, implement [AgentAdapter](src/agents/types.ts), register it in [registry.ts](src/agents/registry.ts), and add protocol tests that prove its observable turn, approval, cancellation and resume behavior. The coordinator and UI consume the existing contract. What an adapter owns is in the [rules](docs/rules.md).

The [native protocol manifest](test/fixtures/native/manifest.json) records the tested CLI versions, capture models and launch arguments. Dependency versions are owned by [package.json](package.json) and its lockfile.

[check-native-update.ts](scripts/check-native-update.ts) runs the installed updater's qualification against explicit `--runtime`, `--executable` and `--out` paths. Without `--allow-account-usage` it checks startup and discovery only. Full qualification also requires `--previous-executable`, creates an isolated old-version conversation, and spends native account usage. `--model` selects an available model; failed and incomplete checks retain diagnostics in the output directory. This command verifies artifacts without changing the native installation.

Witch uses these experimental or undeclared native interfaces:

| Runtime | Interface                                                                    | Use                                                                          |
| ------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Codex   | `thread/settings/update`                                                     | Model and effort changes.                                                    |
| Codex   | `debug models`, `thread/unsubscribe`                                         | Resolve compaction capacity and reload idle sessions when its limit changes. |
| Codex   | `thread/backgroundTerminals/list`, `thread/backgroundTerminals/terminate`    | Background command identity and cleanup.                                     |
| Codex   | `runtimeWorkspaceRoots` on `thread/start`, `thread/resume` and `thread/fork` | Conversation and memory directory access.                                    |
| Claude  | `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`                                      | Native idle and turn completion.                                             |
| Claude  | `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`                  | Session and account usage.                                                   |
| Claude  | `command_lifecycle`                                                          | Input consumption acknowledgements, outside the SDK message union.           |
| Claude  | `getTaskOutput`                                                              | Background output, implemented but undeclared by the SDK.                    |
| Claude  | `getSettings`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`                             | Preserve session flags while applying the automatic compaction limit.        |

### Native protocol fixtures

`pnpm exec vitest run test/agents/native-protocol.test.ts test/agents/native-wire.test.ts` runs offline. It replays recorded JSONL through the production adapters and the installed SDK dependency, checks outgoing Codex requests against the generated schema, and retains the separate scripted fixtures for error and race cases. Schema validation checks wire shape; live captures establish the recorded native behavior.

The Claude recording verifies that a result waits for native idle. Its result also acknowledges the original and steered inputs, so scripted fixtures remain responsible for isolating pending-input lifecycle acknowledgements.

After a CLI upgrade, confirm the account usage before capturing new evidence. Create a task directory under Witch scratch with `mktemp -d -p "$TMPDIR"`. Generate both schema variants into new directories there:

```sh
capture_root=$(mktemp -d -p "$TMPDIR" witch-native-XXXXXX)
codex app-server generate-json-schema --experimental --out "$capture_root/experimental"
codex app-server generate-json-schema --out "$capture_root/stable"
```

Capture `basic`, `control`, `background` and `spell` separately for each runtime, using explicit available models and a new output directory each time:

```sh
pnpm test:record-native --runtime codex --model "$codex_model" --scenario basic --out "$capture_root/codex-basic"
pnpm test:record-native --runtime claude --model "$claude_model" --scenario basic --out "$capture_root/claude-basic"
```

The recorder creates synthetic projects, requests only their named command approvals, checks file effects and native cleanup replies, and retains raw traffic locally. Codex uses `on-request` approvals with user review and a read-only sandbox. Claude uses project settings, strict MCP configuration and default approvals. These per-process capture settings do not change the user's native configuration. The output's `normalized` directory replaces personal paths and account identity while preserving protocol fields, values and ID relationships.

Inspect every normalized stream before copying it into `test/fixtures/native/<runtime>/`. Update the manifest from the successful `capture.json` records, including the SDK version, model, launch arguments and capture date. Copy only the complete generated `codex_app_server_protocol.schemas.json` to `codex/protocol.schema.json`, byte for byte, and record its SHA-256 in the manifest. Compare the stable and experimental definitions against the adapter's consumed interfaces to refresh the inventory above. Review schema and trace diffs before changing expected results; never fill missing native events by hand. Rerun the focused tests and the normal verification below. Keep raw captures out of Git and remove owned scratch after checking its processes and open files.

For changes to [automatic peer-answer isolation](docs/rules.md#session-coordination), run disposable owner/asker conversations with each real runtime. Retain native input and tool output, attempt a local marker write and a fake connected-tool mutation, verify no prompt or target change, and confirm the answer is stored. Check a subsequent normal owner write, interruption during answer startup, and cleanup of the separate process. A model declining an action without invoking a tool does not establish native enforcement; use the native tool result or verified absence of the mutation capability. Keep synthetic targets and captures under Witch scratch, and never use real connected-service writes for this check.

### Final verification before publication

Before a planned push, verify against a freshly fetched main. Keep this work local; the existing hosted workflow and required checks still run normally.

1. Finish and commit the intended edits in the current branch. Require a clean `git status --short`; preserve unrelated work instead of stashing, resetting or deleting it to pass this gate. Fetch main and merge the exact fetched revision, without rebasing:

   ```sh
   verification_status=$(git status --porcelain) &&
     test -z "$verification_status" &&
     git fetch origin main &&
     verification_base=$(git rev-parse FETCH_HEAD) &&
     git merge --no-edit "$verification_base" &&
     git merge-base --is-ancestor "$verification_base" HEAD &&
     verification_head=$(git rev-parse HEAD) &&
     git rev-parse "$verification_head" "$verification_base" "${verification_head}^{tree}"
   ```

   Stop on failure. Resolve merge conflicts before continuing, then repeat the gate. The three printed IDs identify the head, included base and tree to check. Use the disposable-copy rule above when checking an installed checkout.

2. Run the checks required by the change, reusing only qualifying results below. Record those IDs alongside each completed command, exit status and log location in the local, untracked task record. Include dependency installation state, actual Node/pnpm versions, platform and relevant environment or permission settings. Keep records outside the checks' input files; inspect untracked or ignored inputs separately because the tree ID covers only tracked files. Confirm the checked files did not change during the run.

   Reuse a successful result only when that check's complete inputs and environment match. Compare the recorded revision with the candidate, including source, tests, child fixtures, configuration, dependencies and tool versions. Follow the input scope owned by [package.json](package.json), [TypeScript](tsconfig.json), [ESLint](eslint.config.js), [Vitest](vitest.config.ts) and [the build](scripts/build.mjs). Preserve build outputs when the claim depends on them. A different commit with the same tree can reuse results under the same conditions; a docs-only change needs formatting, not another suite run, when the suite's inputs are unchanged. Rerun affected checks when an input changes or a new concern appears; run the full check when the affected scope is uncertain. Failed, interrupted or partial runs cannot establish a successful full check.

3. Immediately before pushing, confirm the recorded head is still current, the checkout is clean and main has not advanced:

   ```sh
   verification_status=$(git status --porcelain) &&
     test -z "$verification_status" &&
     test "$(git rev-parse HEAD)" = "$verification_head" &&
     git fetch origin main &&
     test "$(git rev-parse FETCH_HEAD)" = "$verification_base"
   ```

   A failed fetch stops publication. A changed head or base returns to step 1; compare check inputs before deciding which results need refreshing. Publish the completed change once, without validation-only pushes or hosted reruns. This establishes verification for the recorded base; main can still advance afterward.

## License

[MIT](LICENSE). `test/fixtures/native/codex/protocol.schema.json` is generated by the Codex CLI, which OpenAI licenses under Apache-2.0.
