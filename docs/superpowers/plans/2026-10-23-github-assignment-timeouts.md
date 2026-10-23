# GitHub assignment timeout warnings implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Native execution fits this single task.

**Goal:** A stalled GitHub assignment command produces a warning containing `Timed out after …`, terminates at its deadline, and leaves the local claim intact.

**Architecture:** Use the existing `runCommand` timeout formatter for assignment commands. Derive its optional environment and kill-signal settings from Node's types, retaining assignment's `SIGKILL` and the coordinator's existing warning handling.

**Tech Stack:** Existing TypeScript, Node.js, `node:test`, and real process/control fixtures. No new dependencies.

**Spec:** [#204](https://github.com/pulsedemon/witch/issues/204). [Session coordination](../../rules.md#session-coordination) owns claim behavior.

## Constraints

- Implement in this checkout on `fix/github-assignment-timeouts`. Refresh ownership and main first; merge updates, never rebase.
- Follow [repository conventions](../../../CLAUDE.md), [verification guidance](../../../README.md#development), and [package scripts](../../../package.json). Check the installed Witch path before any build.
- Confirm the changed behavior through the real control transport and fixture commands before editing repository tests. Use Witch's `TMPDIR` for temporary probes.
- Preserve the assignment deadline, argument construction, endpoint aggregation, and retained ownership. Keep timeout classification in `runCommand`; a second formatter would duplicate its responsibility.
- No deployment, migration, force push, branch deletion, or external message is required. Before deleting manually created scratch directories, confirm their exact paths and check peer reservations, live processes, and open files.
- Remove this execution plan after the implementation merges; retain lasting behavior in its owning code and tests.

## Verified basis

Planning used clean main at `8558cf197e3635ecec66b6316dd4734e68ad308e`.

- [assignGitHubTask](../../../src/core/github-assignment.ts:19) runs raw `execFile` with the remaining deadline and `SIGKILL`. Login failures escape directly; assignment failures are collected with their endpoint at line 59.
- [runCommand](../../../src/core/command.ts:9) forwards options and prefixes timeout errors while preserving the error object. Its options type currently omits `killSignal`; [Node's installed definition](../../../node_modules/@types/node/child_process.d.ts:1057) owns that setting's type.
- [Claim dispatch](../../../src/core/coordination.ts:799) persists ownership before assignment and returns its failure as a warning. [ControlResult](../../../src/persistence/control.ts:53) carries that warning to the caller.
- A planning probe on the repository's Node version ran children that ignored `SIGTERM`. Raw execution reported `Command failed`; `runCommand` reported `Timed out after 1000 ms: Command failed`. Both reported `SIGKILL`, and both child PIDs were gone. This verifies the shared runner, not the complete assignment fix.

## Review focus

| Condition                                       | Coverage                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login command times out                         | New control-request case checks the warning, surviving claim, and stopped child.                                                                   |
| Assignment POST times out                       | Second control-request case checks the same result through endpoint error aggregation.                                                             |
| Child ignores `SIGTERM`                         | Stalled assignment fixture ignores it; completion and PID checks detect losing `SIGKILL`. Runner metadata coverage checks the explicit signal too. |
| Permission, spawn, or other command failure     | Existing assignment and runner cases retain native diagnostics without a timeout label.                                                            |
| Deadline already expired or assignment succeeds | Existing tests retain the no-command check, exact arguments, assignment confirmation, ownership, and retry behavior.                               |

## Task 1: Route assignment commands through the shared timeout formatter

**Files:**

- Modify `src/core/command.ts`: accept the native kill-signal option.
- Modify `src/core/github-assignment.ts`: call the shared runner and remove the obsolete execution wrapper and imports.
- Modify `test/command.test.ts` and `test/github-assignment.test.ts`: cover signal forwarding and the returned warning.
- Reuse `test/fixtures/coordination.ts` and `src/persistence/control.ts` without changing their contracts.

**Interfaces:** Keep `runCommand(command, args, options): ReturnType<Run>` and `assignGitHubTask(references, cwd, deadline): Promise<void>`. Set the runner's options type to `Parameters<Run>[2] & Pick<ExecFileOptions, 'env' | 'killSignal'>`, importing the native type. Do not expose unrelated execution options or change `Run`.

- [x] **Step 1: Reproduce both timeout paths through a temporary fixture probe.** Reuse the assignment test's fake `gh`, real coordination fixture, and `callControl`. Run fresh scenarios holding `user` and `repos/acme/widget/issues/42/assignees`, each with one GitHub reference. Inject the real `assignGitHubTask` with deadline `Math.min(deadline, Date.now() + 2000)` so the control request retains time to return. Make the held child ignore `SIGTERM`. Record the warning, returned and persisted claim, command arguments, and child PID. The baseline must report a generic command error while retaining ownership and stopping the child. Register release/teardown before assertions; release the fixture and await pending calls in `finally`.

- [x] **Step 2: Make the production change.** Widen only the runner options described above. Replace assignment's raw execution call with `runCommand`, keeping `{ cwd, timeout, killSignal: 'SIGKILL' }`. Remove the unused `execFile`, `promisify`, and local `execute`. Run `pnpm typecheck`; it must exit 0.

- [x] **Step 3: Replay the probe before updating tests.** Both scenarios must return `kind: 'claimed'` with a warning matching `/Timed out after \d+ ms: Command failed: gh api/`. Persisted ownership must equal the returned claim, and probing the held child's PID must throw `ESRCH`. Complete each control request within 5 seconds. The POST warning must retain its endpoint context.

- [x] **Step 4: Preserve these checks in repository tests.** Add `login timeout returns a warning with ownership intact` and `assignment timeout returns a warning with ownership intact`, using the same bounded real assignment call. Let the local test fixture accept an assignment function, defaulting to `assignGitHubTask`; the underlying coordination fixture already supports injection. Change its hold policy to select an endpoint and update its existing hold callers. In both new cases, assert:

  ```ts
  assert.equal(result.kind, 'claimed');
  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
  assert.match(
    result.warning ?? '',
    /Timed out after \d+ ms: Command failed: gh api/,
  );
  assert.deepEqual(await f.registry.claims(), [result.claim]);
  assert.equal((await a.query()).ownClaim?.id, result.claim.id);
  assert.throws(() => process.kill(heldPid, 0), { code: 'ESRCH' });
  ```

  Verify the exact endpoint sequence for each scenario and the POST endpoint in its warning. Retain the direct expired-deadline test and its PID check, changing its timeout assertion to require the new label. Extend `native timeout failures retain their output and metadata` with an explicit `SIGKILL` variant, retaining the default `SIGTERM` variant and every output/metadata assertion. These cover the returned assignment diagnostic, complete control response, and native signal forwarding as separate responsibilities. Keep all other existing cases.

- [x] **Step 5: Verify, simplify, and prepare the change.** Run the focused command below, then `pnpm check`; both must exit 0. If this checkout is the installed Witch, follow the README's disposable-copy verification procedure. Investigate failures against this task's win condition; do not change unrelated timeouts. Run `simplify-changes`, inspect the final diff, and load `commit-message` before committing the completed change.

  ```sh
  pnpm exec node --import ./scripts/register.mjs --test test/command.test.ts test/github-assignment.test.ts test/coordination.test.ts
  pnpm check
  ```

## Execution record

- The real control-transport probe failed both timeout-label assertions on unchanged main, then passed both after the production change and before repository test edits. Ownership and stopped-child checks passed in both runs.
- All 53 focused checks passed. Final `pnpm check` passed all 1,353 tests, typecheck, lint, build, and compiled help.
- The first full run passed 1,352 of 1,353 tests. Its only failure was the existing [handoff presence-write count](../../../test/coordinator-coordination.test.ts:635), which observed two writes instead of one. The isolated case passed on both trees. A temporary probe on unchanged `8558cf1` reproduced the assertion by delaying `StateStore.create` by 250 ms: the old activation published `idle` and then `starting`, both with one request. The target is [prepared before disconnect](../../../src/core/coordinator.ts:312), while [presence updates use a 100 ms timer](../../../src/core/coordination.ts:277). This establishes an existing timing-sensitive assertion; it does not establish the exact schedule of the first full run. No unrelated code, timeout, concurrency, or retry setting changed.
- The local simplification check and one independent review found no further changes or declined judgments. The reviewed source and test hashes matched after final verification.
- Execution followed the user's checkout and scratch rules. A temporary failing probe preceded implementation, and repository tests changed only after that probe passed. Independent review ran alongside the full check; file hashes verified that the code stayed unchanged.
