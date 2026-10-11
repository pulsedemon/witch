# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Witch is a full-screen Ink terminal app that drives the installed Codex and Claude Code CLIs and shares a Git-backed memory between them. It is a personal macOS app. Scope, lifecycle, recovery rules and module ownership live in [docs/implementation-plan.md](docs/implementation-plan.md). Setup, tested native versions and the steps for adding an agent live in [README.md](README.md).

## Commands

`fs-ext` is a native module currently built for Homebrew Node 26.5 (`/opt/homebrew/bin/node`). The agent shell resolves nvm's default Node 24 LTS first, and under it every suite that loads `StateStore` fails with a `NODE_MODULE_VERSION` mismatch. Prefix commands with `PATH=/opt/homebrew/bin:$PATH` rather than running `pnpm rebuild fs-ext`, which would break the user's own shell.

```sh
pnpm typecheck
pnpm lint      # eslint, then prettier --check
pnpm format
pnpm test      # every test/*.test.ts
pnpm exec node --import tsx --test test/memory.test.ts
pnpm exec node --import tsx --test --test-name-pattern='invalid effort' test/claude.test.ts
pnpm build     # tsc -p tsconfig.build.json into dist/
```

`pnpm dev <project>` needs an interactive terminal and throws when stdin or stdout is not a TTY. `pnpm test:integration` runs real turns on both signed-in CLIs and spends account usage, so confirm before running it.

## Architecture

`src/cli.tsx` opens the `StateStore`, builds one `Coordinator` from `Memory` and the adapters found on `PATH`, and renders `App`.

- `Coordinator` (`src/core/coordinator.ts`) is the only owner of application state. It publishes an immutable `Snapshot`; `App` reads it through `useSyncExternalStore`, batched to 40 ms, and calls coordinator methods. Every action runs through `operate()`, which rejects unless the phase is `idle` (`recovery` for memory recovery) and finishes in `settle()`, which moves to `recovery` whenever the memory repo is dirty.
- `performTurn` records an `activity` with the memory base revision, wraps the prompt with Witch context, a memory snapshot when the native session's `deliveredRevision` is stale, and any activated handoff summary. Memory is committed only after a completed turn. Interrupted or failed turns leave it dirty until the user accepts or discards.
- `handoff()` runs a summary turn on the source agent, saves `handoff` with `activated: false`, connects the destination, then activates it. Failure before activation restores the source; after it, the destination stays resumable. Each conversation keeps one native session per agent in `sessions[agent]`.
- Adapters implement `AgentAdapter` from `src/agents/types.ts`, and native protocol types stay inside them. Claude uses `@anthropic-ai/claude-agent-sdk` pointed at the installed CLI and finishes a turn on the native `session_state_changed` idle event, never on `result` alone. Codex speaks JSON-RPC to `codex app-server --stdio` through `src/agents/json-rpc.ts`.
- State lives under `~/.witch` or `--state-dir`. `state.json` follows the zod schema in `src/core/state.ts` and is written atomically through a serialized queue. `history/<conversation>.jsonl` holds append-only `DisplayUpdate` records folded by `applyDisplayUpdate`. `instance.lock` is an exclusive `flock` that rejects a second instance. `memory/` is a separate Git repo with `global/` and `projects/<repo name>-<sha256 prefix>/` scopes. The recorded agent PID and start time let a restart stop an orphaned agent process.

macOS assumptions are deliberate: memory editing launches VS Code from `/Applications`, and process identity reads `/bin/ps`.

## Tests

Tests use `node:test` and `node:assert/strict` with top-level `await test(...)` and real temp directories and Git repos. Adapter tests inject a launch function that spawns `test/fixtures/claude.mjs` or `test/fixtures/codex.mjs`, scripted stand-ins for the native protocols. Coordinator tests use an in-process `FixtureAgent`. UI tests render through `ink-testing-library`.

## Conventions

- ESM with `NodeNext`: relative imports end in `.js`, including imports of `.ts` and `.tsx` sources.
- `verbatimModuleSyntax` and `consistent-type-imports` require `import type` for type-only imports. `no-floating-promises` is an error, so detached promises are marked with `void`.
- Commits use `type(scope): summary` with the module as scope, such as `core`, `ui`, `memory`, `claude` or `cli`.
