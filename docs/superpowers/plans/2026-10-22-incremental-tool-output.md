# Incremental tool output implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution fits the shared parser and layout changes.

**Goal:** Appending tool output preserves the text, hyperlinks and anchors of a fresh render without repeatedly scanning or copying the unchanged output.

**Architecture:** Preserve append provenance at the display-update owner, retain completed layout rows behind immutable views, and materialize only requested rows. Keep the unfinished text and its hyperlink state together in the link renderer so that a raw newline inside a terminal escape cannot become an incorrect cache boundary.

**Tech Stack:** Existing TypeScript, React/Ink, `node:test`, `@alcalzone/ansi-tokenize`, `linkify-it` and `wrap-ansi`. No new dependency.

**Spec:** [#208](https://github.com/pulsedemon/witch/issues/208). [Repository rules](../../rules.md#terminal-ui-and-persistence) own the display and interaction guarantees.

## Performance contract

The user approved preserving current rendering and allowing a rebuild when incomplete or malformed terminal escapes change earlier lines' interpretation (2026-10-22). Rebuild the affected tail in those cases, including a full block when the uncertain sequence starts at its beginning. This is the accepted exception to the issue's unconditional performance wording.

For stable input, extension work must be proportional to newly received text plus the unfinished logical line, amortized over appends. Frame assembly may still visit the displayed items; it must not visit every cached row. Reading a page should visit its requested rows and the blocks containing them. Replacements, width changes, expansion changes, and changed titles, directories, diffs or images retain their existing rebuild behavior.

## Constraints

- Follow [repository conventions](../../../CLAUDE.md) and the user's runtime-before-test-edit workflow. Reproduce before editing source, verify through the running rendering path, then add repository regressions.
- Execute in this checkout on `fix/incremental-tool-output`. Refresh peers, claim, Git state and main first. Integrate main by merge.
- Preserve the history format, immutable coordinator snapshots, old layout frames, link sanitization, complete output, and existing interaction behavior. No output truncation, dependency patch, worker, or assistant-Markdown optimization.
- Keep `src/core/coordinator.ts` and the adapters unchanged. Their existing append/replacement inputs already provide the needed information.
- No deployment, migration, force push, branch deletion or external post is part of this plan. Use Witch scratch for probes; confirm deletion before removing owned scratch. Do not rebuild an installed checkout without authorization.
- Keep progress in this plan and remove it after the implementation merges. Source and regression tests own the lasting behavior.

## Verified basis

Planning used `c0e2c17da226a074621a7fcf0c0eabdecd189905`, matching GitHub main on 2026-10-22.

- [Codex output deltas](../../../src/agents/codex.ts#L1057) and [Claude shell output](../../../src/agents/claude.ts#L468) mark appends. [Coordinator.receive](../../../src/core/coordinator.ts#L1239) maps that to `replace`, and [merge](../../../src/core/state.ts#L123) owns concatenation. The resulting `DisplayItem` loses that provenance. [App](../../../src/ui/app.tsx#L139) batches notifications for 40 ms, so a layout can miss intermediate items.
- [extend](../../../src/ui/transcript-layout.ts#L163) compares the whole prefix and copies earlier rows and anchors. [tailOf](../../../src/ui/transcript-layout.ts#L75) rescans the prefix and searches earlier anchors. [render](../../../src/ui/transcript-layout.ts#L227) then flattens all blocks, while [App](../../../src/ui/app.tsx#L1108) needs only a page. Changing `extend` alone cannot remove that last cost.
- The installed tokenizer's `parseLinkCode` searches for the second semicolon before looking for a terminator: `node_modules/@alcalzone/ansi-tokenize/build/tokenize.js:17`. Its dispatch at line 138 tries that parser before generic OSC handling. Consequently, an earlier terminator does not establish a stable boundary for an incomplete OSC 8 opener. [linkify](../../../src/ui/links.ts#L146) consumes those tokens and carries the target until another link token changes it.
- The issue's exact input reproduces on this revision. A second probe used `stable`, an incomplete OSC 8 opener, 2,000 `earlier line` rows, then the issue's suffix. The fresh result changed from 2,003 visible lines to exactly `stable\none\ntwo`. This establishes the scope exception above; it does not establish a strict bound for arbitrary escape sequences.
- The baseline probe appended `appended row\n` to `plain output row\n` repeated 2,000, 20,000 and 100,000 times. It used `applyDisplayUpdate`, width 100, an expanded tool, and a 30-row page read. After five warmups, median layout times over 25 appends were 0.19 ms, 1.69 ms and 12.18 ms. A second probe included the display update in CPU measurements: after ten warmups, five batches of 50 appends gave medians of 0.285 ms and 12.349 ms per append at 2,000 and 100,000 lines. The Task 2 threshold rejects that baseline at 1.639 ms. These measurements do not predict post-change timing.
- [Frame tests](../../../test/layout.test.ts#L268) retain an earlier frame after another render. [Selection](../../../src/ui/app.tsx#L218) compares stored row text and anchors. Mutating an earlier frame's rows or anchors is therefore not a valid shortcut.

## Files and interfaces

| File                                                     | Responsibility                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/ui/links.ts`                                        | Own safe text boundaries and carried hyperlink state alongside the existing token consumption.                       |
| `src/core/state.ts`                                      | Retain runtime append provenance and expose newly appended text without comparing or slicing the accumulated prefix. |
| `src/ui/transcript-layout.ts`                            | Extend completed rows, replace the unfinished tail, expose row views, and preserve frame-local anchors.              |
| `src/ui/app.tsx`                                         | Read rows through the view and continue materializing only the visible page.                                         |
| `src/ui/selection.ts`                                    | Read selected rows through `at`, accepting both arrays and layout views.                                             |
| `test/links.test.ts`, `test/layout.test.ts`              | Parser correctness, immutable frames, cache invalidation and append cost.                                            |
| `test/store.test.ts`, `test/coordinator-session.test.ts` | Replay and live append/replacement relationships.                                                                    |
| `test/selection.test.ts`, `test/ui-transcript.test.ts`   | Copying, scrolling and selection through the row view.                                                               |

## Review focus

1. Several updates arrive between renders, or a replacement merely looks like an append. Task 2 must prove ancestry through the producer and reject replacement reuse.
2. A terminator, semicolon, escape introducer or grapheme arrives in another chunk. Task 1 must retain the unresolved suffix and assert literal text and targets.
3. A later append reinterprets previously visible lines. Task 1 covers the reported input and the 2,000-line variant without changing earlier returned frames.
4. The user reads or selects old output while another block grows. Task 2 covers row access, anchors, copying, and returning to follow mode.
5. A new image or diff arrives with unchanged or appended text. Task 2 must invalidate the body cache and retain the existing image/diff behavior checks.

## Task 1: Make the link renderer own the reusable text boundary

**Files:** `src/ui/links.ts`, `src/ui/transcript-layout.ts`, `test/links.test.ts`, `test/layout.test.ts`.

**Interfaces:** Keep `linkify(text: string, cwd: string): string`. Add `linkifyAppend(text: string, cwd: string, target?: string): LinkedAppend`, where `LinkedAppend` contains `complete: string[]`, `tail: string`, `pending: string`, and optional `target: string`. `complete` contains rendered complete lines before the safe boundary; `tail` renders the remaining raw `pending` text; `target` is the active hyperlink at the start of `pending`. The final empty row belongs to the tail. An unresolved escape can keep multiple raw lines in `pending`.

- [x] Confirm the performance exception. The user chose to preserve rendering and allow it.
- [x] Refresh the owning dependency implementation before coding; retain its current semantics.
- [x] Reproduce the issue with one `TranscriptLayout` rendered before and after the suffix, and with a fresh layout at the final text. Use ESC U+001B and BEL U+0007. Input: `ESC + ']8;x' + BEL + '\nfoo'`; suffix: `';https://x.test/' + BEL + 'one\ntwo'`. Save the baseline result in the execution record.
- [x] Share the existing token-to-link rendering inside `links.ts`, allowing the carried target as input and returning its final value. Preserve `linkify`'s public result. Keep terminal-control filtering, target validation and the 2,000-character bare-link pieces in their current owner.
- [x] Implement the safe-boundary calculation next to that renderer. A raw newline is reusable only outside an unresolved control sequence. Match the installed tokenizer's precedence, including a missing OSC 8 parameter separator, BEL, C1 ST, ESC-backslash, C1 introducers and incomplete SGR sequences. Carry a valid open hyperlink across complete lines. Rendering still uses the existing tokenizer; the boundary calculation must not become a second renderer.
- [x] Replace `tailOf`, `linkOpen` and `oscOpen` with the returned checkpoint. Keep only the current raw pending suffix and the target at its start. Render that suffix plus the next delta; commit newly complete lines and retain the remaining tail. Derive row and logical-line positions while emitting rows instead of searching earlier anchors. A larger unresolved suffix uses the approved exception.
- [x] Run the reproduction through the changed layout and through `App` with `fake`/`show`, using real display updates. Require visible `one` and `two`, both linked and underlined to exactly `https://x.test/`, with no `foo` or extra blank body row. Check the 2,000-line variant and unmount the fixture before editing repository tests.
- [x] Add `an OSC 8 separator arriving after a terminator rebuilds the uncertain tail`. Assert literal body rows `['one', 'two']`, the exact target on each word, no link to `https://x.test/one`, and literal body anchors `(line 1, offset 0)` and `(line 2, offset 0)`. Then compare every line and anchor with a fresh layout as a separate equivalence check.
- [x] Add `streaming links retain their target and unresolved controls across chunks`. Split the reported input at every string boundary; cover valid multiline OSC 8, its closing sequence, generic OSC with embedded newlines, and the three supported terminators. Assert visible text, target and underline independently of `linkifyAppend`. Retain existing forged-control and unsupported-target assertions.
- [x] Extend the existing layout frame matrix with a split URL, quoted file path near the existing 2,000-character cut, CRLF, and a grapheme split across updates. Each must retain the same literal text/target as its unsplit input, plus fresh-layout equivalence. Keep the existing replacement, resize, collapse, title and cwd cases.
- [x] Run `pnpm exec node --import tsx --test test/links.test.ts test/layout.test.ts` and `pnpm typecheck`; both exit 0. Confirm that restoring the old boundary logic makes the new malformed-input regression fail. Load `commit-message` before committing this independently verified correctness change.

## Task 2: Remove accumulated-prefix work from live appends and page reads

**Files:** `src/core/state.ts`, `src/ui/transcript-layout.ts`, `src/ui/app.tsx`, `src/ui/selection.ts`, and the remaining test files in the file map.

**Interfaces:** Add `appendedDisplayText(previous: DisplayItem, current: DisplayItem): string | undefined` in `state.ts`. Keep `TranscriptLayout.render`'s inputs and its `starts`, `anchorAt` and `rowOf` results. Its `lines` and each entry in `blocks` become `Pick<readonly string[], 'length' | 'at' | 'slice'>`. `slice` returns an ordinary mutable array for App's highlighting. Change only `selectedText`'s first parameter to `Pick<readonly string[], 'at'>`.

- [ ] At `merge`, record append ancestry in a module-private `WeakMap` keyed by `DisplayItem`. An immutable node records its stream identity, sequence position, appended chunk and preceding node. New items and replacements start a new identity. Nodes must not retain earlier `DisplayItem` objects or cumulative text strings. The history schema and serialized records stay unchanged.
- [ ] Implement `appendedDisplayText` by checking stream identity and walking only the nodes newer than the prior item. Require the walk to reach that exact ancestor, then join those chunks in order. Return `undefined` for unknown ancestry, replacements, sibling histories and backward updates. Preserve an empty string for a valid empty append. Do not compare prefixes or slice `current.text` to rediscover the delta.
- [ ] Use that result in layout extension and remove the `startsWith` check. This must handle any number of updates skipped by App's 40 ms batching. Unknown ancestry gets the existing full-build path. Preserve metadata invalidation and include changed images as well as diffs. Convert the existing streaming frame matrix to explicit `DisplayUpdate` sequences: append deltas, replacements with `replace: true`, and unchanged item snapshots for resize/toggle frames. Preserve its expected inputs and assertions so these checks continue to exercise extension after provenance is required.
- [ ] Keep completed rows in an append-only array and each block frame's completed-row count and unfinished tail separately. A row owns its text and anchor together. Extending the current block appends only newly completed rows and creates a new tail; an older frame retains its count and its old tail. Replacements and other rebuilds start separate storage. Push rows iteratively, without spreading an unbounded log into a function call.
- [ ] Build transcript row views over the blocks and their starting positions instead of flattening all rows. `at` finds one block; `slice` visits only the requested range. Preserve standard negative-index behavior. Capture counts and tails in each returned view, so later renders cannot change its values. Keep unchanged block views identical for the existing cache assertion.
- [ ] Preserve `anchorAt`'s item lookup and make `rowOf` find the target logical line without walking the entire completed prefix. Search within that line for the existing offset rule, including unknown offsets and fallback to the item start. Preserve the current end-of-frame and missing-item behavior.
- [ ] Update App's indexed accesses to `at`; retain its existing visible-page `slice`. Update `selectedText` to use `at`. Tests that inspect all rows explicitly call `slice()`; preserve all their assertions. Do not introduce an array proxy or a general collection framework.
- [ ] Verify a live App fixture before editing tests: send several updates between renders, grow a tool above a selected later item, copy the selected text, scroll up during further output, return to the bottom, and resize. Require the selected text, visible links and reading position to remain correct. Verify that replacing a selected row still clears selection.
- [ ] Add `layout receives every skipped append but rebuilds after replacement`. Build items with `applyDisplayUpdate`; skip at least three intermediate frames with distinct chunks, then replace with a longer same-prefix string and append again. Assert literal rows and anchors at each observed frame. Repeat through `foldDisplayUpdates` followed by a live append. Keep the existing replay title/cwd assertions unchanged.
- [ ] Extend `agent events reach the transcript with their own replace, append and cwd` to feed its actual snapshots into a layout. Assert the rendered result across the existing append and replacement events. This verifies the producer-to-consumer relationship without adding adapter protocol behavior.
- [ ] Add `an earlier layout frame retains its rows and anchors after the tool grows`. Save text, `starts`, every anchor and reverse lookup before multiple appends; assert they are unchanged afterward. Include an append finishing the last line, an append creating new lines, and a following block whose start moves.
- [ ] Preserve the existing UI selection/copy/scroll cases against row views, and add the live tool-growth case above. Add the missing transition from an image-free appendable block to a block with an image; assert its placeholder rows and anchors are present. Retain the existing diff-arrival, full-diff, image-resize and long-output checks.
- [ ] Add `warm tool appends and a fixed page do not scale with completed prefix rows`. Use the baseline workload at 2,000 and 100,000 prefix lines, with the same deltas, identical last lines and a 30-row page. After ten warmups, measure five batches of 50 display updates plus layout/page reads with `process.cpuUsage`; compare median CPU milliseconds per append. Require `large <= small * 4 + 0.5`. The constant allows short-measurement noise while the baseline fails by more than 10 ms. Keep the existing 20k-line full-render comparison because it catches a different regression; construct its append frames through `applyDisplayUpdate` so it exercises the actual fast path.
- [ ] Inspect the hot path for accumulated-text comparisons, prefix scans, copied row/anchor prefixes, and eager flattening. Reintroduce the baseline mechanisms in a disposable verification copy and confirm the new performance check detects the loss. Record the measured results rather than claiming an asymptotic proof from timings alone.
- [ ] Run `pnpm exec node --import tsx --test test/store.test.ts test/coordinator-session.test.ts test/links.test.ts test/layout.test.ts test/selection.test.ts test/ui-transcript.test.ts` and `pnpm typecheck`; both exit 0.
- [ ] Run `simplify-changes`, then `pnpm check` in an appropriate verification checkout and `git diff --check`. Require exit 0. Record the runtime, regression, mutation and performance evidence here. Load `commit-message` before committing. Publishing or merging is outside this planning request.

## Plan review

The required work reaches five product files because append provenance is lost upstream and rows are flattened downstream. A local regex fix leaves those costs; mutating returned arrays breaks retained frames. The proposed changes keep each responsibility with its existing owner and add no public history format.

The approved exception is recorded in the performance contract. Every existing production consumer of layout rows and selected text is included, and the regression checks cover both independent expected results and incremental/fresh equivalence. Native execution is selected. Verification uses current local dependencies and existing fixtures; paid native integration is not needed.

## Execution record

- Started from `c0e2c17` on `fix/incremental-tool-output`; refreshed main has the same revision. The #208 claim is active. The installed Witch points to `/Users/michael/work/witch`, not this checkout.
- Pre-flight: Task 1 produces linked complete lines plus a pending raw suffix and its starting target; Task 2 consumes that checkpoint when storing rows. The interfaces agree. The approved plan is the ledger, and task artifacts live under `/Users/michael/.witch/scratch/f37cab2e-4b79-4b86-84b0-9547029d644f/issue-208.1yPQo7`.
- Workflow: Work stays in this checkout. The user's runtime-before-test-edit order takes precedence over the skills' repository-test-first default; the scratch reproduction supplies the initial failure.

- Task 1 verification: the baseline runtime assertion failed on the wrong text and target; the changed layout and mounted App passed both the short and 2,000-line probes before repository test edits. Focused tests passed 61/61, typecheck and focused ESLint exited 0. The new malformed-input regression failed against baseline source in the mutation copy.
