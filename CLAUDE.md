# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Witch is a full-screen Ink terminal app that drives the installed Codex and Claude Code CLIs and shares a Git-backed memory between them. It is a personal macOS app. Scope, lifecycle, recovery rules and module ownership live in [docs/rules.md](docs/rules.md). Setup, tested native versions and the steps for adding an agent live in [README.md](README.md).

## Commands

Setup, local checks and focused test commands are in [README.md](README.md#development).

Scope local checks to the change and leave the full suite to [ci](.github/workflows/ci.yml). For a change confined to source and tests, run `pnpm typecheck` and `pnpm exec vitest related --run <changed files>`; the [pre-commit hook](.husky/pre-commit) runs `pnpm lint`. `vitest related` follows imports, not spawned processes, and exits 0 when it selects nothing; that is not a pass, so run the tests that exercise the change by name. Run the full `pnpm check` locally when the change touches configuration, dependencies or the build, or macOS-only behavior that Linux ci can't exercise (locks, process identity, `sips`), or when the affected scope is uncertain.

Run each check once, capturing its exit code and complete log, and never rerun it to recover output. After a failure, rerun the failed step, the steps after it and any earlier step whose inputs the fix changed.

`pnpm dev` opens this repo, takes the same arguments as `witch`, and needs an interactive terminal. Confirm before running `pnpm test:integration`.

## Architecture

`src/cli.ts` parses the arguments and runs control commands, familiar wrappers and `--spawn`, which `src/cli/spawn.ts` carries out. For the app, it imports `src/Witch.tsx`, which opens the `StateStore`, builds one `Coordinator` from `Memory` and the adapters found on `PATH`, and renders `App`.

- [Coordinator](src/core/coordinator.ts) owns application state for the open conversation and publishes the [Snapshot](src/core/snapshot.ts) read by `App` through `useSyncExternalStore`, batched to 40 ms. Operation admission, queued delivery and compaction follow [the canonical rules](docs/rules.md#witch-commands-and-compaction). [PromptDelivery](src/core/prompt-delivery.ts) owns prompt admission, steering and queue draining. [Compaction](src/core/compaction.ts) owns pending requests; [memory settlement](src/core/memory-settlement.ts) classifies publication and recovery after an operation.
- [TurnRunner](src/core/turn-runner.ts) runs each turn; its memory, recovery, handoff and Claude idle-completion rules are in [docs/rules.md](docs/rules.md).
- Adapters implement `AgentAdapter` from `src/agents/types.ts`. Codex's JSON-RPC transport is `src/agents/codex/json-rpc.ts`. [ModelCatalog](src/core/runtime/models.ts) owns the combined picker catalog and explicit runtime/model identity.
- The state directory's layout is owned by `src/persistence/store.ts`, `src/persistence/directories.ts`, `src/memory/memory.ts`, whose `memoryRepository` places `memory.git`, and `src/Witch.tsx`, which places `jobs/`, `changes/` and `scratch/`. [instanceDirectory](src/persistence/instance.ts) owns job-report and snapshot directories; [ScratchSpace](src/persistence/scratch.ts) owns scratch.

Witch's desktop behavior targets macOS. Linux support is limited to the [development checks and native verification procedure](README.md#development). [Locking](src/persistence/lock.ts), [control-file access](src/persistence/control.ts) and [process inspection](src/persistence/process.ts) own their platform boundaries.

## Tests

Suite tests use Vitest with `node:assert/strict` and real temp directories and Git repos. Import `test` without awaiting registration. [vitest.config.ts](vitest.config.ts) owns discovery and runner policy; [test/fixtures/vitest-setup.ts](test/fixtures/vitest-setup.ts) owns lifecycle setup. Standalone child fixtures retain `node:test` where they exercise its process behavior.

Temp directories come from `scratch()` in `test/fixtures/scratch.ts`, which removes them, never from `mkdtemp`. Tests that need a memory repository take it from `seededMemory()` in `test/fixtures/seeded-memory.ts`, except tests of `Memory.initialize`. Adapter tests inject a launch function that spawns `test/fixtures/claude.mjs` or `test/fixtures/codex.mjs`, scripted stand-ins for the native protocols. Coordinator tests use the in-process `FixtureAgent` in `test/fixtures/agent.ts`. UI tests render through `ink-testing-library`, or through `show()` in `test/fixtures/ui.ts` when they depend on the terminal's height. Spawned fixtures run with a temp cwd and an absolute fixture path, since they write files into their cwd.

## Conventions

Name runtime helpers for their responsibility without repeating the runtime folder name. Group files by responsibility within their existing layer; keep JSX files in PascalCase and JSX-free helpers in `.ts`, and name a `.ts` file whose only runtime export is a hook after that hook, as in `useLiveState.ts`. [ESLint](eslint.config.js) enforces filenames; [the rules](docs/rules.md#ownership) define ownership.

- ESM with `NodeNext`: relative imports end in `.js`, including imports of `.ts` and `.tsx` sources.
- `verbatimModuleSyntax` and `consistent-type-imports` require `import type` for type-only imports. `no-floating-promises` is an error, so detached promises are marked with `void`.
- Commits use `type(scope): summary` with the module as scope, such as `core`, `ui`, `memory`, `claude` or `cli`.
