# Witch

A personal terminal app for installed Codex and Claude Code, with Git-backed shared memory.

## Install

Install Node.js (the version in `package.json` `engines`), pnpm, Git 2.43 or newer and the native agent CLIs. Sign in through each native CLI. VS Code handles file links and memory editing, and a signed-in `gh` adds the branch's pull request to the status line and lets Witch clean up after it merges.

Lock observation requires macOS's `/usr/bin/perl` with its core `Fcntl` and `JSON::PP` modules. Installing the native dependency requires Python 3 and Xcode Command Line Tools.

```sh
pnpm install && pnpm build && pnpm install:cli
```

Rerun `pnpm build` after changes, and `/restart` loads the new build into a running Witch's conversation. When a built Witch finishes cleaning up after a merge into Witch's own repository, it also pulls and rebuilds this checkout, if this one sits on the base branch with nothing staged, modified or conflicted. If another Witch is updating this checkout, the refresh is skipped with a notice.

If the checkout moves, the installed launcher names its missing target. Run `pnpm build && pnpm install:cli` from the relocated Witch checkout to repair it.

## Usage

```sh
cd project && witch
```

Flags and the state default are in `witch --help`. Use `/help` for keyboard controls and `Ctrl+P` for commands.

Use `/compact` while idle to compact the current native conversation. Automatic compaction follows the [coordinator's pre-turn policy](src/core/coordinator.ts).

Other Witch sessions and exclusive task claims are described under [session coordination](docs/rules.md#session-coordination).

Codex and Claude can delegate work to each other through the [familiar reporting path](docs/rules.md#native-adapters-and-execution), with native identity, activity and a saved report.

For a moved project directory, use the directory-recovery commands in `witch --help` from its replacement directory. Preview first; applying recovery requires every Witch using that state directory to be closed and retains the original files in a backup.

Witch names each tab by its current task and repeats notifications while a request, memory recovery or fatal error waits for you. A successful settled turn gets one notification. [Terminal attention](src/ui/terminal.ts) owns eligibility and title selection. [Desktop scheduling](src/persistence/notifications.ts) spaces alerts across sessions sharing a state directory; bursts can wait, and stale alerts cancel. Titles and bells keep their timing.

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

Installing dependencies enables the [pre-commit hook](.husky/pre-commit), which runs `pnpm lint` across the working tree: the existing [ESLint configuration](eslint.config.js), then Prettier's formatting check. Fix reported errors, or run `pnpm format` for formatting, and retry the commit. The [ci workflow](.github/workflows/ci.yml) runs the complete `pnpm check` on Linux.

`pnpm check` also builds `dist`. Agents validating a checkout installed as `witch` must use a disposable copy unless an installed rebuild is authorized. Keep `TMPDIR` outside that copy so fixtures that model non-repositories do not inherit its Git identity. Running the app and native checks requires the [installation prerequisites](#install).

The [desktop CLI test](test/cli-desktop.test.ts) builds in scratch through the same [build script](scripts/build.mjs), so its startup deadline measures the compiled executable.

`pnpm test` runs the suite with Vitest. [vitest.config.ts](vitest.config.ts) owns discovery, worker policy and the React compiler transform.

Run a file or one of its named tests with Vitest:

```sh
pnpm exec vitest run test/memory.test.ts
pnpm exec vitest run test/coordinator-session.test.ts -t 'completion in a later turn'
pnpm exec vitest run test/coordinator-turns.test.ts -t '^pending command context waits until a prompt is dispatched > turn: connect$'
```

Watch a selected file, or pause its worker for a source debugger:

```sh
pnpm exec vitest --watch test/rpc.test.ts --clearScreen=false
pnpm exec vitest run test/rpc.test.ts --inspect-brk=127.0.0.1:9229 --no-file-parallelism --testTimeout=0 --hookTimeout=0
```

Fixture edits rerun the selected watch set, including fixtures loaded only by spawned children. Press `q` to quit watch mode. Attach a Node Inspector client to the printed address to set TypeScript source breakpoints and inspect locals, then resume execution. The timeout flags turn off the configured test and hook timeouts, which keep counting while a breakpoint pauses the worker.

Confirm before running `pnpm test:integration`: it runs real turns with your native logins and spends account usage. Set `WITCH_CODEX_MODEL` to choose its Codex model.

`pnpm test:integration:codex-brews` checks native child brews with the installed Codex and a localhost model fixture, without account usage, and retains its evidence under `TMPDIR`.

For native macOS verification, run `pnpm check` locally to exercise Darwin locks, boot/process identity and real `sips` conversion. Linux uses a fixture at the `sips` command boundary. The desktop CLI test uses command fixtures for link opening and clipboard writes on both platforms; actual desktop operations remain manual checks.

Then run both scratch-lifetime checks below. They use fixture agents and private tmux sessions with no account usage, and verify scratch retention, reclamation and uncertainty after exit and repeated `/restart`. They require Python 3, tmux and a writable `TMPDIR` short enough for a tmux socket, and wait through a maintenance interval. Use `--case` to select a scenario. Evidence is retained under `TMPDIR`; inspect it and the recorded processes before removing it.

```sh
python3 scripts/check-scratch-lifetime.py "$PWD/src/cli.tsx"
python3 scripts/check-scratch-lifetime.py "$PWD/dist/cli.js"
```

To add another installed agent, implement [AgentAdapter](src/agents/types.ts), register it in [registry.ts](src/agents/registry.ts), and add protocol tests that prove its observable turn, approval, cancellation and resume behavior. The coordinator and UI consume the existing contract. What an adapter owns is in the [rules](docs/rules.md).

Tested native versions: Codex 0.162.1 and Claude Code 2.1.299. Dependency versions are owned by [package.json](package.json) and its lockfile. Codex settings updates, Claude idle events and Claude's usage report use experimental native interfaces; rerun protocol and live integration checks when upgrading either CLI.

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
