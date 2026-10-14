# Witch

A personal terminal app for installed Codex and Claude Code, with Git-backed shared memory.

## Install

Install Node.js (the version in `package.json` `engines`), pnpm, Git 2.43 or newer and the native agent CLIs. Sign in through each native CLI. VS Code handles file links and memory editing, and a signed-in `gh` adds the branch's pull request to the status line.

```sh
pnpm install && pnpm build && ln -s "$PWD/dist/cli.js" ~/.local/bin/witch
```

Rerun `pnpm build` after changes.

## Usage

```sh
cd project && witch
```

Flags and the state default are in `witch --help`. Use `/help` for keyboard controls and `Ctrl+P` for commands.

Keep the memory repository local or back it up yourself; the app never pushes it. Conversations retain native session IDs, so native session storage must remain available for resume.

The lifecycle, recovery rules and scope are defined in the [rules](docs/rules.md).

## Development

The development scripts are in [package.json](package.json). `pnpm test:integration` runs real turns with your native logins and spends account usage. Set `WITCH_CODEX_MODEL` to choose its Codex model.

To add another installed agent, implement [AgentAdapter](src/agents/types.ts), register it in [registry.ts](src/agents/registry.ts), and add protocol tests that prove its observable turn, approval, cancellation and resume behavior. Keep backend types and protocol handling inside its adapter. The coordinator and UI consume the existing contract.

Tested native versions: Codex 0.162.1 and Claude Code 2.1.296. Dependency versions are owned by [package.json](package.json) and its lockfile. Codex settings updates, Claude idle events and Claude's usage report use experimental native interfaces; rerun protocol and live integration checks when upgrading either CLI.
