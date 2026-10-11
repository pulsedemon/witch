# Personal coding harness implementation plan

## Goal and constraints

Build a full-screen terminal app for the installed Codex and Claude Code. Prove shared memory in fresh conversations, task handoffs, interruption recovery, and Cmd+click web/file links. This is a personal macOS app with production-quality, maintainable code.

Use TypeScript, Node.js 22+, pnpm, React and Ink 8 in one package. Use strict types, direct imports and behavioral tests. Work on a branch in this checkout. No direct provider runner, remote service, parallel task execution, automatic Git pushes, imported conversations or changes to separately launched agents.

## Ownership

- UI renders coordinator state and submits typed actions. It owns focus, scrolling and hyperlink rendering, not processes or Git.
- Coordinator owns logical conversations, native session mappings, turn lifecycle and durable handoffs.
- Adapters own native protocols, processes, permission requests and capabilities.
- Memory owns scoped files, accepted revisions, Git commits and interrupted-write recovery.
- Persistence owns atomic metadata and append-only display history.

Native types stay in adapters. Adding a backend requires an adapter, registration and the behavioral contract tests. Keep facts in their owning source, with documentation linking to it.

## Task 1: Native adapters and execution

Discover installed executables. Use Codex app-server over stdio and Claude Agent SDK with the installed Claude Code. Tested versions are recorded in the [README](../README.md). Preserve native prompts, instructions, skills, settings, hooks, integrations and permissions. Forward approvals, questions and MCP elicitation. Keep credentials native.

Use ordinary input for changing memory and handoffs. Do not overwrite Codex instruction configuration or rely on changed Claude system-prompt snapshots. Discover models with paginated Codex model/list and Claude supportedModels; idle Claude refresh uses reinitialize. Accept explicit model IDs without silently substituting models. Reflect actual model and permission settings.

Verify real streaming, model selection, approvals, cancellation and resume. Claude result alone does not establish idle; completion must follow native lifecycle. Test result followed by more activity before idle.

## Task 2: Terminal UI and persistence

Use an alternate-screen header, scrolling transcript, fixed multiline composer and status footer. Sessions/models use pickers; memory has a list and preview. Enter sends, Shift+Enter inserts a newline, bracketed paste never submits. Ctrl+P opens commands; PageUp/PageDown scroll. Escape closes a view before interrupting. Ctrl+C interrupts active work or exits while idle. Commands: /new, /sessions, /agent, /model, /memory, /help, /quit.

Follow output only at the bottom. Keep typing responsive with long expanded tool results, preserve scroll on view changes and resize, batch streamed display changes and reuse completed rendering. Web links use OSC 8 and the default browser. File references use encoded VS Code URLs with optional line/column, resolved against their originating cwd. Preserve links in Markdown, bare text, tool output, wrapping and clipping. Test actual Cmd+click in Ghostty.

Persist native IDs and display history. One coordinator exclusively owns application state. Reject another instance; recover after a dead owner and reconcile native execution. Never automatically replay a prompt.

## Task 3: Shared memory

Keep memory in a dedicated Git repository under ~/.agent-harness, separate from logs and handoff state. Separate global and canonical-project scopes. Existing project docs remain authoritative. Agents use ordinary file tools and scoped native permissions; only the coordinator manages memory Git operations.

Each turn begins with clean memory and durable base-revision/origin metadata. Successful completion commits that turn's changes, with attribution and no empty commits. Accepted memory is HEAD. Interrupted, failed or uncommitted changes remain pending; block new execution until explicit accept/discard recovery. Never sweep another turn's pending changes into a later commit.

Before every turn, compare the accepted revision with the session's delivered revision. Supply current essentials and changes/deletions, explicitly superseding old content. Search deeper notes as files. Memory UI supports search, history, diffs, VS Code editing while paused and restoration through a new commit. No vector store.

## Task 4: Handoffs and recovery

Stop or finish the source and resolve memory; generate and save its handoff; initialize the destination; atomically activate it; submit current context and continuation. Before activation, failure retains the source. After activation, failure leaves the destination resumable. Return-to-agent resumes its prior native session. Keep both sessions and never replay automatically.

Test A-to-B-to-A, initialization failure, cancellation and restart at each transition boundary, checking active session, cwd and context.

## Task 5: Acceptance and review

Test fresh memory transfer both directions without the fact appearing in the prompt, handoff or project docs. A second project gets global preferences but excludes private project notes. Test current-session edit/delete/restore propagation, interrupted tracked/new notes and provenance, exclusive ownership, and approval outcomes.

Complete a disposable coding task across both agents, run its checks, restart the app and continue. Run typechecking, linting, meaningful automated tests and live integration checks. Inspect the real Ghostty UI, including typing, paste, scroll, resize, exit restoration, long URLs and web/file links. Complete simplify-changes and a fresh whole-change review.

## Review record

Two rounds of three Astra ultra reviews found the revised plan ready. Remaining implementation cautions are authoritative native idle detection and avoiding the assumption that clipping alone bounds rendering cost.
