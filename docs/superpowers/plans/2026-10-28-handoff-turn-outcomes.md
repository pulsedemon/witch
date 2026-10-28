# Handoff continuation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Native execution fits these two dependent tasks.

**Goal:** Pass #307's coordinator checks: finished and legacy conversations switch without starting work, interrupted and failed turns continue, outcomes survive restart, and old completions never notify again.

**Architecture:** Persist one optional `lastTurn` on the conversation record. Ordinary-turn finalization owns it; handoff reads it before summarizing. Keep `Snapshot.completedTurn` as the transient notification signal, derived from the recorded successful result only after its final save.

**Tech stack:** Existing TypeScript, Zod, Vitest and coordinator fixtures. Toolchain versions and commands remain owned by [package.json](../../../package.json).

**Spec:** [#307](https://github.com/pulsedemon/witch/issues/307). The issue owns the requested behavior and acceptance criteria; this plan supplies implementation and verification decisions.

## Constraints and execution boundary

- Follow [repository conventions](../../../CLAUDE.md), [Witch rules](../../rules.md) and the user's standing instructions. Implement on a `fix/` branch in this checkout; merge main, never rebase.
- Use the existing coordinator, state store and notification contracts. No new dependencies, provider protocol changes or historical-record migration is needed.
- Reproduce and verify the corrected behavior through a scratch coordinator probe before editing repository tests. Put scratch under the active Witch `TMPDIR`, outside any disposable verification checkout; create task directories with `mktemp -d -p "$TMPDIR"`.
- Follow the [installed-build and native-integration restrictions](../../../README.md#development). Fixture verification requires no paid native turns or deployment. No irreversible action is part of this implementation plan.
- Approved for execution by this conversation's user on 2026-10-28. This conversation owns the #307 claim. Keep execution progress here, and remove this plan after the implementation merges.

## Verified basis and approach

Source references below were read at `1c77d6e8c149e310f2aa1e85a9a6da7586f5446c`.

| Owner                                                                                                                                                                                                                                                                                                                                                                                                            | Consequence for the change                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Conversation record schema](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/state.ts#L58), [record reader](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/persistence/store.ts#L79), [record writer](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/persistence/store.ts#L286)         | Add the optional field to the existing schema; save and reopen through the real store. No separate persistence mechanism.                       |
| [Ordinary-turn finalization](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/coordinator.ts#L953)                                                                                                                                                                                                                                                                     | Store the result before the existing final save. Successful completion currently publishes only after that save.                                |
| [Compaction](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/coordinator.ts#L985)                                                                                                                                                                                                                                                                                     | It also calls `beginActivity('turn')`. Recording outcomes in `beginActivity` or `finishActivity` would misclassify compaction as ordinary work. |
| [Handoff](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/coordinator.ts#L801)                                                                                                                                                                                                                                                                                        | Capture the source outcome before the summary; condition the existing continuation at line 830 on it.                                           |
| [Pending handoff delivery](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/coordinator.ts#L882), [prompt construction](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/prompts.ts#L133), [success cleanup](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/coordinator.ts#L967) | The next prompt already carries the saved summary, and success clears it. Preserve that path.                                                   |
| [Conversation adoption](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/core/coordinator.ts#L319), [terminal completion](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/ui/terminal.ts#L172), [CLI startup](https://github.com/pulsedemon/witch/blob/1c77d6e8c149e310f2aa1e85a9a6da7586f5446c/src/cli.tsx#L332)                     | Keep completion transient. Verify restart notifications with the terminal watcher attached before initialization, matching the CLI.             |

Persisting the ordinary result is the sufficient approach. Transient state cannot satisfy restart behavior; summary wording cannot substitute for the outcome required by the issue. Keep the existing `completedTurn` consumer API, so `src/ui/terminal.ts` needs verification rather than a redesign.

[PR #345](https://github.com/pulsedemon/witch/pull/345) was open at `f4a3029` during planning. It overlaps the coordinator, state schema, prompts, fixtures and several affected tests. [Draft #297](https://github.com/pulsedemon/witch/pull/297), at `7b6e5b0`, also overlaps coordinator/state/notification code. Both GraphQL review-thread lists were empty. Refresh these PRs, their threads and session claims before implementation. Merge any landed main changes and reread affected methods before applying this plan; do not modify either peer's checkout.

## Review focus

Each condition has a concrete check in the tasks below.

| Condition                                                             | Regression to detect                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A summary or compaction completes after interrupted ordinary work     | Internal work must not replace the ordinary outcome and suppress the required continuation. |
| The native result succeeds but the final save is pending or rejected  | No completion signal or terminal notification may escape before successful persistence.     |
| A finished conversation reconnects or restarts                        | The saved outcome remains available without announcing an old completion.                   |
| An older saved conversation has user history and no outcome           | A nonempty summary must remain pending instead of triggering work.                          |
| A prompt queues during switching, or a destination continuation fails | Preserve prompt delivery and the existing failed-turn queue hold.                           |

## Task 1: Persist ordinary outcomes and derive live completion

**Files:** Modify `src/core/state.ts`, `src/core/coordinator.ts`, `test/coordinator-attention.test.ts` and `test/coordinator-compaction.test.ts`. Reuse `test/fixtures/coordinator.ts`, `test/fixtures/agent.ts`, `src/persistence/store.ts` and `src/ui/terminal.ts` unchanged.

**Interface:** Add `lastTurn?: { id: string; status: 'completed' | 'interrupted' | 'failed' }` to `conversationRecordSchema`, with the type inferred through `ConversationRecord`. Keep `Snapshot.completedTurn?: string` and the signatures of `performTurn`, `handoff` and `watchTerminal` unchanged.

- [x] Refresh peers and promote/renew the #307 claim. Check the working tree, refresh main and overlapping PRs, then create or reuse `fix/handoff-turn-outcomes` in this checkout. Preserve this ignored plan file. Stop on unexpected checkout changes.
- [x] Set `TASK_SCRATCH=$(mktemp -d -p "$TMPDIR" plan307.XXXXXX)` and create a standalone TypeScript probe there using `fixture`, `TurnGate`, `readRecord` and `watchTerminal`. Run it with `pnpm exec node --import tsx "$TASK_SCRATCH/probe.mts"`. Capture the activity ID while a source turn is gated; exercise completion, `coordinator.interrupt()` and a fixture failure. Record saved metadata, destination inputs and notification output. Baseline: no saved `lastTurn`, and a switch after success starts an unwanted destination input. Close every coordinator and watcher in `finally`.
- [x] Add the optional schema field. In `performTurn`, after `finishActivity` succeeds and before the existing final `save`, assign `{ id: activity.id, status: result.status }` only for `kind === 'turn'`. After the save resolves, derive the successful notification ID from that record. Preserve clearing the transient signal before an ordinary attempt and when adopting a conversation. Summary, compaction, memory recovery and reconnect must not write `lastTurn`; pre-dispatch failures keep their existing queued-input behavior.
- [x] Rerun the probe before changing repository tests. All three finalized outcomes must save the captured ordinary activity ID; only completed work emits completion after persistence. Closing and reopening must retain the record and emit no old completion. At this intermediate step, handoff still starts its existing continuation.
- [x] Update `completion identifies the successful activity only after its final save` to assert the persisted result instead of treating non-persistence as the contract:

  ```ts
  assert.deepEqual(stored.lastTurn, { id: activity.id, status: 'completed' });
  assert.equal(coordinator.snapshot.completedTurn, stored.lastTurn.id);
  ```

  Keep its gated-save assertions and the existing rejected-save regression. Extend the failed/interrupted cases to check their own saved IDs and statuses after a previous success. Capture IDs from the active record through `TurnGate`; do not invent them from the implementation under test. Preparation failure must still leave the prompt queued and emit no completion.

- [x] Add `reconnect and restart retain the ordinary outcome without replaying completion`. Observe an initial success, reconnect the same runtime without sending a prompt, and assert no additional notification or input. For restart, close the original coordinator, construct another over the same store, memory and fixture agents, attach `watchTerminal` before `initialize(project, { continue: true })`, and wait one event-loop turn. Assert the saved result is unchanged, `completedTurn` is absent and no completion was emitted. A subsequent explicit prompt must produce a new saved ID and exactly one completion. Stop both watchers.
- [x] Add `compaction preserves the last ordinary-turn outcome` in the compaction suite. Finish an ordinary turn as interrupted, save its result, complete compaction and compare the full saved result, including its ID. This detects accidentally recording compaction as ordinary work.
- [x] Run `pnpm exec vitest run test/coordinator-attention.test.ts test/coordinator-compaction.test.ts` and `pnpm typecheck`. Both must exit 0. Keep the current 1,500-line lint limit; use local comment/whitespace cleanup if needed, without splitting the coordinator for this change.

## Task 2: Gate continuation and preserve deferred context

**Files:** Modify `src/core/coordinator.ts`, `docs/rules.md`, `test/coordinator-switch.test.ts`, `test/coordinator-attention.test.ts`, `test/coordinator-turns.test.ts`, `test/coordinator-compaction.test.ts`, `test/coordinator-memory.test.ts` and `test/coordinator-merge-events.test.ts`.

**Consumes:** `ConversationRecord.lastTurn` from Task 1. **Produces:** Conditional continuation through the existing `handoff(selection: ModelSelection): Promise<void>` and unchanged pending-context delivery.

- [x] At the beginning of `handoff`, capture whether `lastTurn.status` is `interrupted` or `failed`, before calling the summary turn. After destination activation is saved, invoke the existing continuation only when that captured condition and the nonempty summary both hold. Keep a nonempty summary pending otherwise; clear an empty handoff as before. Preserve activation, rollback and session-resume behavior.
- [x] Run the probe again before editing tests. Check the matrix below through the real coordinator and store. For a finished source, assert zero destination inputs at switch completion, then send a distinct user prompt, assert its exact prompt and saved summary arrive together, and assert success clears the handoff.

  | Source outcome                          | Immediate switch    | Close/reopen, then switch              |
  | --------------------------------------- | ------------------- | -------------------------------------- |
  | `completed`                             | No destination turn | No destination turn                    |
  | `interrupted`                           | One continuation    | One continuation                       |
  | `failed`                                | One continuation    | One continuation                       |
  | Missing in an older record with history | No destination turn | Covered by reopening that older record |

- [x] Encode the matrix as coordinator switch tests. For each current outcome, finish a real fixture turn; for restart variants, close and reopen before selecting the destination. Capture `lastTurn` before switching and assert the summary leaves it unchanged: inspect the saved record at a gated destination continuation, or after selection when no continuation runs. Release the gate before awaiting completion. Assert destination input count and prompt, not just selected-agent state. Continuation text must equal the existing literal in `handoff`, and its context must contain the source summary. For the legacy case, remove only `lastTurn` from a closed conversation's JSON, retain its history and sessions, reopen through schema validation, then switch. Do not backfill or infer an outcome from history.
- [x] Adapt existing tests without dropping their distinct guarantees:

  | Existing test or suite                                                   | Required adaptation                                                                                                                                                                                                                                                 |
  | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Switch round-trip and selected model/effort dispatch                     | Assert no destination input after a successful-source switch, then send an explicit prompt before checking dispatched model, effort, session ID and context.                                                                                                        |
  | Durable activation before continuation; cancellation during continuation | Seed an interrupted ordinary source turn locally so these tests still enter the continuation branch. Preserve activation-save and destination-ownership assertions. Do not change the shared handoff fixture for unrelated tests.                                   |
  | Attention: conversation adoption and silent handoff summary              | Keep adoption/reset coverage; after a finished-source switch, assert no destination input and no new completion ID. Use an explicit gated destination prompt to verify the next completion.                                                                         |
  | Turns: failed continuation keeps queued prompts                          | Seed an interrupted source, fail the destination continuation and retain the `/review` queue assertion.                                                                                                                                                             |
  | Switch: prompt queued during summary                                     | Assert the queued prompt is the sole destination input, carries the summary and clears the pending handoff on success.                                                                                                                                              |
  | Compaction: background records and pending handoff                       | Remove the destination failure flag used only to manufacture pending context. The successful-source switch now creates that state directly. Preserve background-record and later context-delivery assertions.                                                       |
  | Memory: discard after activated handoff                                  | Seed an interrupted source so the attempted continuation still reaches the existing memory-conflict gate. Preserve zero destination inputs before recovery and both native-session corrections. Send an explicit prompt after returning to the now-finished source. |
  | Merge events: receipts across restart and runtime switch                 | Assert no destination input on selection, then send an explicit prompt before checking first delivery and subsequent receipt deduplication.                                                                                                                         |

- [x] Update the [handoff rule](../../rules.md#handoffs-and-recovery) to state conditional continuation and deferred context. Link to the coordinator for field names and mechanics. Keep existing recovery and no-replay guarantees.
- [x] Run the focused suites below. Then use `simplify-changes`, run `pnpm check` under the README's installed-build rule, and inspect the final diff. Required result: every command exits 0; all matrix assertions hold; failed saves, queue handling, recovery and notification suppression retain their coverage. New failures require a diagnosis before edits or reruns.

  ```sh
  pnpm exec vitest run test/coordinator-switch.test.ts test/coordinator-attention.test.ts test/coordinator-turns.test.ts test/coordinator-compaction.test.ts test/coordinator-memory.test.ts test/coordinator-merge-events.test.ts test/terminal.test.ts test/store.test.ts
  pnpm check
  ```

- [x] Record verified results here and present the implementation diff. Load `commit-message` before any commit and `pr-writing` before any PR text. Before deleting disposable task scratch, verify ownership and contents, refresh reservations, and check live processes and open files. Retain deliverables. Release the claim only after this task and any delegated work have ended.

## Planning verification

The plan was checked against every requirement in #307 and the current owning implementations. It introduces one persisted field and one continuation condition; test changes preserve existing behavioral assertions. At planning completion, product code and repository tests were unchanged. The execution ledger below records implementation and verification.

## Execution ledger

- Base: `2ba9a70`, after fast-forwarding main through #345 and #350. Branch: `fix/handoff-turn-outcomes`. The issue remains open; #345 is merged with no review threads. Its queue changes preserve the finalization and handoff contracts used here.
- Pre-flight: Task 2 consumes the optional `ConversationRecord.lastTurn` produced by Task 1. The field and statuses agree; no interface conflict.
- Ruling: Use the existing checkout branch, this plan as ledger and `/Users/michael/.witch/scratch/3121a5c9-76e4-4174-a6c1-8612211be76e/plan307.lLo4wN` for disposable artifacts. User workspace preferences and Witch scratch rules override spell bookkeeping scripts. This changes no product behavior.
- Ruling: Scratch probes supply the initial failing checks; repository tests follow confirmed runtime behavior, as the approved plan and user verification order require.
- The installed launcher targets `/Users/michael/work/witch/dist/cli.js`; this checkout can run `pnpm check` without rebuilding that installed app.
- Task 1: complete. The baseline passed 33 tests. The scratch probe failed for missing persisted outcomes, then passed after implementation, including reconnect/restart notifications and compaction. The updated focused suites pass 35 tests; typecheck exits 0.
- Sandbox execution initially failed with `spawn EPERM` before any fixture input. The unchanged baseline and probes ran with approved local process permissions. This was an environment failure, not a product regression.
- Task 2 reproduction: the handoff probe failed for completed sources before and after restart, and for a legacy record. It showed an unwanted continuation consuming the summary before the next explicit prompt.

- Task 2 runtime probe: all seven live/restarted/legacy scenarios pass. Focused verification passed 270 of 271 tests; the one failure exposed a misplaced test setup flag, corrected locally. Both affected recovery tests then passed; typecheck passed.
- Simplify-changes: reviewed the complete changed lifecycle, schema and affected tests. Kept the existing notification and pending-context interfaces; no additional abstraction or provider change is needed.

- Independent final review: `gpt-6-astra` reviewed the entire working diff against `2ba9a70` and the approved plan. No findings. No files, scratch artifacts or child processes were created by the reviewer.
- Final ruling: Native-provider correctness was outside the review because adapters and protocols are unchanged. The authorized verification uses real coordinator/store/notification code with fixture agents; it makes no claim about new live-provider behavior.

- Task 2: complete. `pnpm check` exited 0 on the reviewed working tree: 107 test files, 1,710 tests passed, plus typecheck, ESLint, Prettier, build and CLI help. The full suite also reran all corrected focused cases.
- Publication: the user requested a PR on 2026-10-28. Retain this plan with the branch until the implementation merges; Git and GitHub own publication and review state.
- Cleanup: inspected all 11 owned probe/log files, refreshed session reservations, confirmed the reviewer had ended, and checked process arguments/environments and open files. No use remained; the task scratch directory was removed. The plan and implementation remain in the checkout.
