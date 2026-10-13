# Witch rules

## Goal and constraints

Build a full-screen terminal app for the installed Codex and Claude Code. This is a personal macOS app with production-quality, maintainable code.

Use TypeScript, pnpm, React and Ink in one package. Use strict types, direct imports and behavioral tests. No direct provider runner, remote service, parallel task execution within a conversation, automatic Git pushes, imported conversations or changes to separately launched agents. Separate instances run concurrently, each with one conversation open.

## Ownership

- UI renders coordinator state and submits typed actions. It owns focus, scrolling and hyperlink rendering, not processes or Git. The status line's Git and pull request fields come from `RepositoryWatch` in [repository.ts](../src/core/repository.ts).
- Coordinator owns logical conversations, native session mappings, turn lifecycle and durable handoffs.
- Adapters own native protocols, processes, permission requests and capabilities.
- Memory owns scoped files, accepted revisions, Git commits, publishing and interrupted-write recovery.
- Persistence owns atomic metadata, append-only display history and conversation locks.

Native types stay in adapters. The steps for adding a backend are in the [README](../README.md). Keep facts in their owning source, with documentation linking to it.

## Native adapters and execution

Discover installed executables. Use Codex app-server over stdio and Claude Agent SDK with the installed Claude Code. Tested versions are recorded in the [README](../README.md). Preserve native prompts, instructions, skills, settings, hooks, integrations and permissions. Forward approvals, questions and MCP elicitation. Keep credentials native.

Use ordinary input for changing memory and handoffs. Do not overwrite Codex instruction configuration or rely on changed Claude system-prompt snapshots. Discover models with paginated Codex model/list and Claude supportedModels; idle Claude refresh uses reinitialize. Accept explicit model IDs without silently substituting models. Reflect actual model and permission settings. Discover skills with Codex skills/list and Claude supportedCommands without its built-ins, and replace the list on Codex skills/changed and Claude commands_changed. Run a skill natively: Codex gets a skill input with its path, Claude gets `/name args` as the last text block after Witch's context. Connect the agent when a conversation opens, so its skills are listed before the first prompt. Witch's UI calls skills spells.

Claude result alone does not establish idle; completion must follow native lifecycle.

## Terminal UI and persistence

Use an alternate-screen header and status row, a scrolling transcript, a multiline composer that grows with its text up to half the screen, and a two-row status line at the foot showing, for either agent, the fields `~/.claude/statusline.sh` shows, rendered by Witch without running the script. Each adapter reports what its agent can of context, cost, limits and changed lines, and an unreported field takes the script's default. A right sidebar beside a main column of at least 80 cells holds a pentacle that turns while the agent works. Sessions/models use pickers; memory has a list and preview. Keys and commands are defined by the `/help` text in [app.tsx](../src/ui/app.tsx).

Follow output only at the bottom. Keep typing responsive with long expanded tool results, preserve scroll on view changes and resize, batch streamed display changes and reuse completed rendering. Capture the mouse: the wheel scrolls and a click opens the link under it, while Shift+drag keeps native selection and mouse reporting ends on exit. Web links use OSC 8 and the default browser. File references use encoded VS Code URLs with optional line/column, resolved against their originating cwd. Preserve links in Markdown, bare text, tool output, wrapping and clipping.

Persist native IDs and display history. Each instance has one conversation open, and its coordinator exclusively owns that state. Refuse a conversation another instance holds; recover after a dead owner and reconcile native execution. Never automatically replay a prompt.

## Shared memory

Keep memory in a dedicated bare Git repository, separate from logs and handoff state, and give each conversation its own worktree on its own branch. Separate global and canonical-project scopes. Existing project docs remain authoritative. Agents use ordinary file tools and scoped native permissions; only the coordinator manages memory Git operations.

Each turn begins with clean memory and durable base-revision/origin metadata. Successful completion commits that turn's changes, with attribution and no empty commits. Accepted memory is `main`; a clean worktree publishes its commits by rebasing onto `main`. Interrupted, failed or uncommitted changes remain pending; block new execution until explicit accept/discard recovery. MEMORY.md, the index every agent keeps, merges both sides' lines. Any other change that conflicts with another conversation's enters conflict recovery, where keep mine resolves each conflicting change to this conversation's side and merges the rest, and discard mine resets to `main`. Never sweep another turn's pending changes into a later commit.

Before every turn, compare the accepted revision with the session's delivered revision. Supply current essentials and changes/deletions, explicitly superseding old content. Search deeper notes as files. Memory UI supports search, history, VS Code editing while paused and restoration through a new commit. No vector store.

## Handoffs and recovery

Stop or finish the source and resolve memory; generate and save its handoff; initialize the destination; atomically activate it; submit current context and continuation. Before activation, failure retains the source. After activation, failure leaves the destination resumable. Return-to-agent resumes its prior native session. Keep both sessions and never replay automatically.
