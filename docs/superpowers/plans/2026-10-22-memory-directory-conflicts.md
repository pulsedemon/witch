# Memory file/directory conflict implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this single task in the current checkout. Track completion with the checkboxes below.

**Goal:** After “keep mine,” the conflicting path has this conversation's file or directory, accepted memory contains no Git-generated alternate path, and recovery names the original path.

**Architecture:** Decode Git's structured conflict records once for both workspace consumers. Resolve recorded file/directory collisions inside the existing temporary index, then use the existing commit and publication flow.

**Tech stack:** Existing TypeScript, Node.js, Git and node:test. [package.json](../../../package.json) owns versions and commands.

**Spec:** [Issue #166](https://github.com/pulsedemon/witch/issues/166).

**Baseline:** `cafe5be383b791f4cfa7dbdaf1a949dd94ef48e5`, inspected on 2026-10-22 with Git 2.45.2. The plan was approved for native execution. Implementation and verification are complete.

## Constraints

- Follow [CLAUDE.md](../../../CLAUDE.md), [repository rules](../../rules.md) and the user's global instructions. Use `fix/memory-directory-conflicts` in this checkout.
- Preserve the existing public workspace interfaces, content merges, rename handling, modify/delete choices, attribution and publication race handling. [The current tests](../../../test/memory.test.ts#L747) own those guarantees.
- Confirm the correction through real scratch memory repositories before editing repository tests, following the user's verification order.
- Keep the Git version floor in [README](../../../README.md#install). No dependency changes are needed.
- Run checks that rebuild `dist` in a disposable copy, as required by [README](../../../README.md#development). The installed `witch` points at this checkout's build.
- Execution ends with verified local changes. Scratch deletion is the only planned action outside Git that cannot be reverted: remove only task-created directories under Witch's `TMPDIR`, after checking reservations, open files and live processes, under the user's standing cleanup authorization.

## Verified cause and approach

[Workspace.conflict](../../../src/memory/workspace.ts#L364) and [Workspace.keepMine](../../../src/memory/workspace.ts#L404) suppress merge messages. The former returns Git's relocated filename; the latter only removes listed paths deleted from this branch and commits the remaining merge tree. [Coordinator](../../../src/core/coordinator.ts#L1416) forwards the conflict paths, and [App](../../../src/ui/app.tsx#L788) displays them directly. The correction belongs in the workspace.

Git's [NUL-delimited output schema](https://github.com/git/git/blob/v2.43.0/Documentation/git-merge-tree.txt#L126) includes structured message records. Its [2.43 implementation](https://github.com/git/git/blob/v2.43.0/merge-ort.c#L3678) and [2.45.2 implementation](https://github.com/git/git/blob/v2.45.2/merge-ort.c#L3745) identify file/directory collisions with `CONFLICT (file/directory)` and the ordered pair of relocated and original paths. Use those fields, without interpreting the human-readable message or guessing from filename suffixes.

Three probes used the unchanged `Memory` and `Workspace` classes over isolated repositories:

| Conversation's choice                                   | Baseline result after keep and publish                           | Verified candidate tree                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Directory `global/x/y.md`                               | Also contains `global/x~<oid>`                                   | Keeps `global/x/y.md` only at the conflict                                       |
| File `global/x`                                         | Contains their `global/x/y.md` and moves mine to `global/x~HEAD` | Keeps `global/x` at the conflict                                                 |
| File `global/x[1]`, with a real `global/x[1]~HEAD` note | Moves mine to `global/x[1]~HEAD_0`                               | Keeps the chosen file, the real tilde-named note and their unrelated `global/x1` |

For each recorded pair, the candidate used `git --literal-pathspecs reset --quiet HEAD -- <relocated> <original>` with the existing temporary `GIT_INDEX_FILE`. All three probes preserved unrelated notes, HEAD and the real index bytes. Git's [reset implementation](https://github.com/git/git/blob/v2.45.2/builtin/reset.c#L148) removes absent entries and restores source entries recursively through the selected index; [the path-taking branch](https://github.com/git/git/blob/v2.45.2/builtin/reset.c#L463) leaves HEAD unchanged. Runtime checks used Git 2.45.2; the minimum-version check was source inspection.

## Files and interfaces

| File                      | Responsibility                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/workspace.ts` | Add file-local `mergeResult(output: Buffer): { tree: string; paths: string[]; relocated: Map<string, string> }`. The map runs from Git's relocated path to its original path. Use it in `conflict()` and `keepMine()`; preserve their signatures. |
| `test/memory.test.ts`     | Add the file/directory cases below and extend the existing crash regression to exercise the new index operation. Reuse `fixture`, `save` and `git`.                                                                                               |

## Review focus

- Both conflict directions must keep the selected shape and bytes. The first two matrix cases exercise different destructive outcomes.
- A legitimate tilde-named note must survive a collision with Git's preferred generated name. The third case requires parsing the actual relocation record.
- Literal path matching must leave a nearby name untouched. The third case gives `global/x1` distinct content from `global/x[1]`.
- Unrelated notes and existing text/rename/delete merges must survive. Each new case includes notes from both sides; retain the existing merge assertions.
- Failure after the new index operation must leave the real index, worktree and revisions intact. Extend the existing crash regression as specified below.

## Task 1: Resolve and display file/directory conflicts

- [x] Refresh peers, the #166 claim and Git state. Continue on the named branch. If main has advanced, inspect the relevant changes and merge main before execution.
- [x] Recreate the matrix below as a scratch runtime probe using two workspaces over one memory repository. Publish their changes first, require `mine.publish()` to return `conflict`, and record `mine.conflict()`, the chosen working files and accepted tree after `keepMine()` followed by `publish()`. Confirm the baseline defects above before changing source.
- [x] Implement `mergeResult` and replace `--no-messages` with `--messages` in both calls. Decode the tree, then conflict paths up to the empty NUL field, then records consisting of path count, that many paths, type and message. Retain raw conflict paths for existing resolution logic. Collect only file/directory relocation pairs; consume other records without treating their fields as filenames. Handle a clean result with no paths or messages.
- [x] In `conflict()`, map relocated conflict paths back to their originals and deduplicate the result. Preserve the existing diff and merge argument order.
- [x] In `keepMine()`, retain the current `-X ours` merge and temporary-index lifecycle. Apply the existing modify/delete handling to the remaining raw conflicts. For each relocation pair, run the verified literal path reset above with the temporary index environment, restoring the original path from HEAD and removing the generated entry. Preserve the captured `latest`, commit messages, parent and final reset order.
- [x] Rerun the scratch probe before editing tests. Require exact expected working-file contents and accepted tree paths for every case, no generated leftovers, and preserved unrelated notes. Check HEAD and the real index before the final workspace reset to confirm the intermediate operation remains isolated.
- [x] Add these workspace regressions. Every case also writes `global/mine.md = "mine-only\n"` on this branch and `global/theirs.md = "theirs-only\n"` on theirs.

  | Test name                                                    | Mine                                                          | Theirs                                                              | Expected conflict path and chosen content                                   |
  | ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
  | `keep mine keeps its directory at a file/directory conflict` | `global/x/y.md = "mine\n"`                                    | `global/x = "theirs\n"`                                             | Path `global/x`; file `global/x/y.md = "mine\n"`                            |
  | `keep mine keeps its file at a file/directory conflict`      | `global/x = "mine\n"`                                         | `global/x/y.md = "theirs\n"`                                        | Path `global/x`; file `global/x = "mine\n"`                                 |
  | `keep mine preserves literal paths and existing tilde names` | `global/x[1] = "mine\n"`; `global/x[1]~HEAD = "user-named\n"` | `global/x[1]/y.md = "theirs\n"`; `global/x1 = "literal-neighbor\n"` | Path `global/x[1]`; all three expected files retain their distinct contents |

  For each case, define `expectedFiles` explicitly from the table plus the two unrelated notes. Assert the conflict path before recovery, successful publication afterward, both working and accepted bytes, and the complete accepted path list:

  ```ts
  assert.equal(await mine.publish(), 'conflict');
  assert.deepEqual((await mine.conflict()).paths, [conflictingPath]);
  await mine.keepMine();
  assert.equal(await mine.publish(), 'published');
  for (const [path, text] of Object.entries(expectedFiles)) {
    assert.equal(await readFile(join(mine.root, path), 'utf8'), text);
    assert.equal(await memory.read(main, path), text);
  }
  assert.deepEqual(
    (await git(memory.root, 'ls-tree', '-r', '--name-only', '-z', main))
      .split('\0')
      .filter(Boolean)
      .sort(),
    ['global/MEMORY.md', ...Object.keys(expectedFiles)].sort(),
  );
  ```

- [x] Extend `a crash inside keep mine before its reset leaves the worktree clean and the conflict standing` with a file/directory case, retaining its existing content-conflict case. Keep the injected failure after `commit-tree`. In the new case, also compare pre/post HEAD, main and real-index bytes before calling `isDirty()`. This catches accidentally running the new reset against the real index even if successful recovery would hide the mistake.
- [x] Run `pnpm exec node --import tsx --test --test-name-pattern='keep mine|conflict view|conflicting note name' test/memory.test.ts test/coordinator-memory.test.ts test/ui-memory.test.ts` and `pnpm typecheck`. Both must exit 0. The existing coordinator check covers publication and attribution; the existing UI checks cover path display and the keep/discard actions.
- [x] In a disposable copy, run the three new regressions with baseline `workspace.ts`; they must fail on the conflict-path assertions. Restore the corrected source and require them to pass. Keep assertions independent of the parser and resolver implementation.
- [x] Run `simplify-changes`, then `pnpm check` against the final tree in a disposable copy. Require exit 0 and `git diff --check` to pass. Record outcomes here. Load `commit-message` before any commit. Remove owned scratch after the required checks; remove this execution plan after the implementation merges.

## Execution record

- Plan self-review: the issue's path, tree and recovery requirements map to the single task. No product decision remains open. Native execution is sufficient because the two consumers share one parser and one verification cycle.
- Planning evidence: all three baseline reproductions and candidate-index assertions completed successfully. These probes preceded implementation.

- Execution baseline: merged main by fast-forward to `a7ba15243fdfbfedf4d9ac9a60fd23647733dd79`. Its native-exit change does not modify the workspace recovery methods. Pre-flight: one task, no cross-task interfaces. This plan owns the execution ledger; transient files remain under Witch scratch.
- The runtime probe failed in all three cases before the source change, then passed 3/3 afterward, including accepted paths, working-file contents and real-index isolation. Repository tests were added only after that check.
- Typecheck passed. Two sandboxed focused runs passed 12/13 but timed out before the coordinator turn entered. A direct fixture probe found `spawn EPERM` at initialization and zero delivered inputs. Checks requiring fixture subprocesses run with process permissions; test deadlines and product code are unchanged.
- In the disposable copy, all three new regressions failed against baseline `workspace.ts` on the expected conflict-path assertions. The corrected source has been restored.
- The focused command passed 13/13 with process permissions. The coordinator entered and completed recovery with its original deadline.
- Local simplify-changes review found no additional change needed: the parser has two consumers, the relocation mapping owns both display and resolution, and the existing commit/publish flow remains intact. Existing regression assertions remain, with the file/directory crash case added.
- Independent final review approved the change with no findings, no declined items and no implementation deviations. It checked the Git protocol, literal temporary-index reset, new regressions and retained merge behavior. The reviewer created no scratch or running processes.
- Full `pnpm check` passed in the disposable copy: typecheck, lint, 1160/1160 tests, build and CLI help. The test suite took 228.6 seconds. The checked product and test files match this checkout byte for byte; its installed build was not rebuilt.
- Task 1: complete. The approved behavior and verification steps are implemented, with no product or scope deviations. Final review found no deferred items.
- The reviewer finished with no children or scratch. Fresh peer/reservation, open-file and process checks found no remaining task users; the owned implementation scratch directory was removed. The branch remains local as specified.
