# Witch

A personal terminal app for installed Codex and Claude Code, with Git-backed shared memory.

## Install

Install Node.js (the version in `package.json` `engines`), pnpm, Git 2.43 or newer and the native agent CLIs. Sign in through each native CLI. VS Code handles file links and memory editing, and a signed-in `gh` adds the branch's pull request to the status line and lets Witch clean up after it merges.

```sh
pnpm install && pnpm build && ln -s "$PWD/dist/cli.js" ~/.local/bin/witch
```

Rerun `pnpm build` after changes, and `/restart` loads the new build into a running Witch's conversation. When a built Witch finishes cleaning up after a merge into Witch's own repository, it also pulls and rebuilds this checkout, if this one sits on the base branch with nothing staged, modified or conflicted. If another Witch is updating this checkout, the refresh is skipped with a notice.

## Usage

```sh
cd project && witch
```

Flags and the state default are in `witch --help`. Use `/help` for keyboard controls and `Ctrl+P` for commands.

Use `/compact` while idle to compact the current native conversation. Automatic compaction follows the [coordinator's pre-turn policy](src/core/coordinator.ts).

Other Witch sessions and exclusive task claims are described under [session coordination](docs/rules.md#session-coordination).

Witch names each tab by its current task and repeats notifications while a request, memory recovery or fatal error waits for you. A successful settled turn gets one notification. [Terminal attention](src/ui/terminal.ts) owns the timing and title selection.

Ghostty controls banners, sound and dock attention. It suppresses notifications for its focused tab in the active window; macOS notification permission and Focus settings also apply. Its shared rate limit can suppress a completion notification when several tabs notify together. Manual tab titles can override Witch's title, and notification forwarding through tmux is not guaranteed.

Keep the memory repository local or back it up yourself; the app never pushes it. Conversations retain native session IDs, so native session storage must remain available for resume.

The lifecycle, recovery rules and scope are defined in the [rules](docs/rules.md).

## Development

The development scripts are in [package.json](package.json). `pnpm test:integration` runs real turns with your native logins and spends account usage. Set `WITCH_CODEX_MODEL` to choose its Codex model.

`pnpm test:integration:codex-brews` checks native child brews with the installed Codex and a localhost model fixture, without account usage, and retains its evidence under `TMPDIR`.

`python3 scripts/check-scratch-lifetime.py "$PWD/src/cli.tsx"` checks scratch retention through the real CLI with fixture agents and no account usage. It requires Python 3 and tmux; pass an absolute built `cli.js` path to check a build.

To add another installed agent, implement [AgentAdapter](src/agents/types.ts), register it in [registry.ts](src/agents/registry.ts), and add protocol tests that prove its observable turn, approval, cancellation and resume behavior. The coordinator and UI consume the existing contract. What an adapter owns is in the [rules](docs/rules.md).

Tested native versions: Codex 0.162.1 and Claude Code 2.1.296. Dependency versions are owned by [package.json](package.json) and its lockfile. Codex settings updates, Claude idle events and Claude's usage report use experimental native interfaces; rerun protocol and live integration checks when upgrading either CLI.
