# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Witch is a full-screen Ink terminal app that drives the installed Codex and Claude Code CLIs and shares a Git-backed memory between them. It is a personal macOS app. Scope, lifecycle, recovery rules and module ownership live in [docs/rules.md](docs/rules.md). Setup, tested native versions and the steps for adding an agent live in [README.md](README.md).

## Commands

Setup, local checks and focused test commands are in [README.md](README.md#development).

`pnpm dev` opens this repo, takes the same arguments as `witch`, and needs an interactive terminal. Confirm before running `pnpm test:integration`.

## Architecture

`src/cli.tsx` parses the arguments, opens the `StateStore`, builds one `Coordinator` from `Memory` and the adapters found on `PATH`, and renders `App`.

- [Coordinator](src/core/coordinator.ts) owns application state for the open conversation and publishes the [Snapshot](src/core/snapshot.ts) read by `App` through `useSyncExternalStore`, batched to 40 ms. Operation admission, queued delivery and compaction follow [the canonical rules](docs/rules.md#witch-commands-and-compaction). [Compaction](src/core/compaction.ts) owns pending requests; [memory settlement](src/core/memory-settlement.ts) classifies publication and recovery after an operation.
- `performTurn` runs each turn; its memory, recovery, handoff and Claude idle-completion rules are in [docs/rules.md](docs/rules.md).
- Adapters implement `AgentAdapter` from `src/agents/types.ts`. Codex's JSON-RPC transport is `src/agents/json-rpc.ts`. [ModelCatalog](src/core/models.ts) owns the combined picker catalog and explicit runtime/model identity.
- The state directory's layout is owned by `src/persistence/store.ts`, `src/memory/memory.ts` and `src/cli.tsx`, which places `memory.git`, `jobs/` and `scratch/`. [instanceDirectory](src/persistence/instance.ts) owns job-report directories; [ScratchSpace](src/persistence/scratch.ts) owns scratch.

Witch's desktop behavior targets macOS. Linux support is limited to the [development checks and native verification procedure](README.md#development). [Locking](src/persistence/lock.ts), [control-file access](src/persistence/control.ts) and [process inspection](src/persistence/process.ts) own their platform boundaries.

## Tests

Suite tests use Vitest with `node:assert/strict` and real temp directories and Git repos. Import `test` without awaiting registration. [vitest.config.ts](vitest.config.ts) owns discovery and runner policy; [test/fixtures/vitest-setup.ts](test/fixtures/vitest-setup.ts) owns lifecycle setup. Standalone child fixtures retain `node:test` where they exercise its process behavior.

Temp directories come from `scratch()` in `test/fixtures/scratch.ts`, which removes them, never from `mkdtemp`. Adapter tests inject a launch function that spawns `test/fixtures/claude.mjs` or `test/fixtures/codex.mjs`, scripted stand-ins for the native protocols. Coordinator tests use the in-process `FixtureAgent` in `test/fixtures/agent.ts`. UI tests render through `ink-testing-library`, or through `show()` in `test/fixtures/ui.ts` when they depend on the terminal's height. Spawned fixtures run with a temp cwd and an absolute fixture path, since they write files into their cwd.

## Conventions

- ESM with `NodeNext`: relative imports end in `.js`, including imports of `.ts` and `.tsx` sources.
- `verbatimModuleSyntax` and `consistent-type-imports` require `import type` for type-only imports. `no-floating-promises` is an error, so detached promises are marked with `void`.
- Commits use `type(scope): summary` with the module as scope, such as `core`, `ui`, `memory`, `claude` or `cli`.
