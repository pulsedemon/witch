# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Witch is a full-screen Ink terminal app that drives the installed Codex and Claude Code CLIs and shares a Git-backed memory between them. It is a personal macOS app. Scope, lifecycle, recovery rules and module ownership live in [docs/rules.md](docs/rules.md). Setup, tested native versions and the steps for adding an agent live in [README.md](README.md).

## Commands

The scripts are in `package.json`. One file or one test runs with:

```sh
pnpm exec node --import tsx --test test/memory.test.ts
pnpm exec node --import tsx --test --test-name-pattern='invalid effort' test/claude.test.ts
```

`pnpm dev` opens this repo, takes the same arguments as `witch`, and needs an interactive terminal. Confirm before running `pnpm test:integration`.

## Architecture

`src/cli.tsx` parses the arguments, opens the `StateStore`, builds one `Coordinator` from `Memory` and the adapters found on `PATH`, and renders `App`.

- `Coordinator` (`src/core/coordinator.ts`) is the only owner of application state for the one conversation it has open. It publishes an immutable `Snapshot`; `App` reads it through `useSyncExternalStore`, batched to 40 ms, and calls coordinator methods. Every action except `initialize`, `send`, `unqueue`, `interrupt`, `respond` and `close` runs through `operate()`, which rejects unless the phase is `idle` (`recovery` for memory recovery) and finishes in `settle()`, which publishes the conversation's memory and classifies what is left. `initialize` settles its own load, `send` steers the turn in flight or queues the prompt until `drain()` runs it through `operate()`, and the other four act while another operation holds the phase.
- `performTurn` runs each turn; its memory, recovery, handoff and Claude idle-completion rules are in [docs/rules.md](docs/rules.md).
- Adapters implement `AgentAdapter` from `src/agents/types.ts`. Codex's JSON-RPC transport is `src/agents/json-rpc.ts`.
- The state directory's layout is owned by `src/persistence/store.ts`, `src/memory/memory.ts` and `src/cli.tsx`, which places `memory.git` and `jobs/`.

macOS assumptions are deliberate: memory editing launches VS Code from `/Applications`, clicked links open with `/usr/bin/open`, copied text goes to `/usr/bin/pbcopy`, images other than PNG convert with `/usr/bin/sips`, process identity reads `/bin/ps`, and conversation locks use `O_EXLOCK`.

## Tests

Tests use `node:test` and `node:assert/strict` with top-level `await test(...)` and real temp directories and Git repos. Temp directories come from `scratch()` in `test/fixtures/scratch.ts`, which removes them, never from `mkdtemp`. Adapter tests inject a launch function that spawns `test/fixtures/claude.mjs` or `test/fixtures/codex.mjs`, scripted stand-ins for the native protocols. Coordinator tests use the in-process `FixtureAgent` in `test/fixtures/agent.ts`. UI tests render through `ink-testing-library`, or through `show()` in `test/ui-app.test.ts` when they depend on the terminal's height. Spawned fixtures run with a temp cwd and an absolute fixture path, since they write files into their cwd.

## Conventions

- ESM with `NodeNext`: relative imports end in `.js`, including imports of `.ts` and `.tsx` sources.
- `verbatimModuleSyntax` and `consistent-type-imports` require `import type` for type-only imports. `no-floating-promises` is an error, so detached promises are marked with `void`.
- Commits use `type(scope): summary` with the module as scope, such as `core`, `ui`, `memory`, `claude` or `cli`.
