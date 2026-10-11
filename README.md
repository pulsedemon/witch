# Witch

A personal terminal app for installed Codex and Claude Code, with Git-backed shared memory.

## Run

Install Node.js 22 or newer, pnpm, Git and the native agent CLIs. Sign in through each native CLI. VS Code handles file links and memory editing.

```sh
pnpm install
pnpm dev /absolute/path/to/project
```

Use `/help` for keyboard controls and `Ctrl+P` for commands. `/model` lists the connected agent's models; `/model <id> [effort]` also accepts an explicit ID. Cmd+click opens web links through the system URL handler and file links in VS Code.

For the compiled app:

```sh
pnpm build
pnpm exec node dist/cli.js /absolute/path/to/project
```

Use the same Node runtime for installation and execution. The file-lock dependency is native; run `pnpm rebuild fs-ext` after changing runtimes. On this machine, pnpm uses Node 26.5.0 while the shell's `node` is 22.16.0, so use the pnpm commands above.

State lives under `~/.witch`. Pass `--state-dir <directory>` for an isolated instance. Keep the memory repository local or back it up yourself; the app never pushes it. Conversations retain native session IDs, so native session storage must remain available for resume.

The lifecycle, recovery rules and scope are defined in the [implementation plan](docs/implementation-plan.md).

## Development

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

`pnpm test:integration` uses existing native logins and consumes account usage. It creates disposable projects, runs real agent turns and prints the artifact directory. It checks native project instructions, memory transfer in both directions, project isolation, a coding handoff and restart. The files are retained for inspection. Set `WITCH_CODEX_MODEL` to select a different model for that check.

To add another installed agent, implement [AgentAdapter](src/agents/types.ts), register it in [registry.ts](src/agents/registry.ts), and add protocol tests that prove its observable turn, approval, cancellation and resume behavior. Keep backend types and protocol handling inside its adapter. The coordinator and UI consume the existing contract.

Tested native versions: Codex 0.162.1 and Claude Code 2.1.296. Dependency versions are owned by [package.json](package.json) and its lockfile. Codex settings updates and Claude idle events use experimental native interfaces; rerun protocol and live integration checks when upgrading either CLI.
