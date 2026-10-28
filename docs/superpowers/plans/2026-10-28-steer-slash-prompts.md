# Steer Slash-Shaped Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A prompt that starts with `/` but names no listed command steers like any other prompt. A spell or native command sent mid-turn reaches its runtime as soon as the runtime can run it, without holding the prompts sent after it. Ordinary prompts queued behind a queued prompt steer into the turn it starts.

**Architecture:** A prompt is a command when `skillCall` matches it against the session's listed commands. Those are spells plus Claude's built-ins, which the Claude adapter now lists flagged `builtin`, minus `clear`, `effort` and `fast`. The coordinator forwards a matched command to `AgentSession.steer` as a `SkillCall`. Claude pushes it raw and runs it after the current native turn, inside Witch's turn. Codex refuses it, so it runs as the next turn. Claude marks any other steered prompt that starts with `/` as `client_composed`, so it joins the running turn as text. `drain` re-splits its batch after connecting. Once a queued turn's input is sent, it steers the prompts queued behind that turn, up to the first `!` command, and waits for that before the turn settles.

**Tech Stack:** TypeScript (ESM, `NodeNext`), Claude Agent SDK 0.3.296 with Claude Code 2.1.299, Codex app-server 0.162.1, Vitest.

**Spec:** [#302](https://github.com/pulsedemon/witch/issues/302). Its line links are pinned to `bbdf280`; the sites below are re-derived at `68ff1aa`. Its `coordinator-turns` tests sit 45 lines lower there, `coordinator-memory:228` is now `:233`, and `ui-prompts:77-124` hasn't moved.

## Evidence

Static evidence comes from the installed CLIs' source, extracted to scratch and not committed. Task 3's live check confirms the runtime behavior the pr cites. One claim stays unverified: that Claude's interrupt receipt lists a held command among `still_queued`. The adapter returns whatever uuids it lists (`src/agents/claude.ts:686-702`), and the pr labels this unverified.

- **Claude path prompts.** Claude Code 2.1.299 folds a mid-turn message into the running turn unless its last text block, trimmed, starts with `/`; the exception is a `client_composed` message (the queue filter keeps `gP(value) && !skipSlashCommands` items back). The check is on shape only. A path prompt is therefore held until the turn ends and then sent as text, because its name, `var/folders/…`, fails the command-name pattern `/^[a-zA-Z0-9_][a-zA-Z0-9:_-]*$/`.
- **`client_composed`.** It sets `skipSlashCommands` and `skipAttachments`. Headless delivery maps `skipAttachments` to skipping mention attachments (`@path`, `@server:resource`, agent and skill mentions), and the ambient pass (nested `CLAUDE.md`, skill listing, reminders) still runs. So `sdk.d.ts:6362-6365`'s "skipped as a whole" is out of date for this CLI. The pass between tool calls is unaffected either way.
- **Claude commands mid-turn.** A spell or built-in pushed mid-turn is held and runs as a command in its own native turn once the current one ends. Its `command_lifecycle` goes `queued`, then `started` and `completed`, under its uuid. `ClaudeSession` already keeps a Witch turn open while a steered uuid is pending, and clears the earlier result on `started` (`src/agents/claude.ts:814-831`, `:1189-1209`). Local built-ins end with a `result` frame; Witch's `/compact` already relies on that (`:1022-1045`).
- **Claude's built-ins.** A promptless `supportedCommands()` call on this machine lists 55 built-ins. They include `clear`, `compact`, `context`, `effort`, `fast`, `model` and `usage`, plus bundled skills such as `simplify`, `verify` and `code-review`.
- **A local built-in's output.** A probe sent `/context` as a session's first message. It cost 0 tokens and got `command_lifecycle` `queued` and `started`, an `assistant` message holding the output, then a `result`. `ClaudeSession` already shows assistant text that arrives without stream deltas (`src/agents/claude.ts:934-946`), so the output reaches the transcript with no adapter change.
- **Codex skills.** At 0.162.1, `turn/steer` takes the same `UserInput` union as `turn/start`, `skill` included. Core expands skills only at turn start (`codex-rs/core/src/session/turn.rs:310`). Steered input is queued raw, and its skill items become nothing (`codex-rs/protocol/src/models.rs:2070`). Neither app-server nor core parses `/` text, so a steered path is plain text.
- **Project skills for the live check.** Codex loads `.agents/skills/<name>/SKILL.md` from the repo root down to cwd, with no trust check (`codex-rs/ext/skills/src/host_roots.rs:137-185`). Claude lists `.claude/skills/<name>/SKILL.md`, confirmed with the same promptless probe.

## Decisions

- **Claude path prompts steer with `client_composed`, not queuing.** Queuing is the reported bug. The flag costs only mention expansion in that one steered message.
- **Claude's built-ins run natively, except `clear`, `effort` and `fast`.** Those three change history or settings that Witch tracks, so they go to Claude as text until Witch owns them (user decision, 2026-10-28; #313 owns `/clear`). `/model` and `/compact` never reach the coordinator, because `submit` runs Witch's commands locally (`src/ui/app.tsx:637-665`). The coordinator's classification therefore covers spells and native commands only. The composer still doesn't offer built-ins.
- **A Codex spell sent mid-turn waits in Witch's queue for the next turn,** the earliest Codex can run it. It no longer holds the prompts sent after it.
- **Ordinary prompts keep their order.** A prompt sent while an ordinary prompt or a `!` command is queued still waits behind it. Only queued spells and native commands that the turn refused stop holding later prompts. A `!` command steers only in the replied window, as today.
- **Without Claude's message lifecycle, a command steer is refused unless the turn has replied, as today.** A held command would otherwise run after Witch's turn ends.
- **`drain` re-splits its batch after connecting,** so a spell queued while its session was down still goes alone (`test/coordinator-turns.test.ts:752`). The batch still leaves the visible queue before `operate`, as today. The screen is unchanged, the batch can't be taken back mid-connect, and a batch is never empty.
- **The steers behind a queued turn finish inside `operate`.** `drain` awaits them right after `performTurn`, while the phase is still `running`. Awaiting them at the top of each iteration instead would leave Witch idle with prompts queued, and the UI pulls a queue back into the composer when it sees idle (`src/ui/app.tsx:798-801`). Every session refuses a steer once its turn has ended (`src/agents/claude.ts:566`, `src/agents/codex.ts:614-615`), so a late one returns to the queue.
- **A Claude CLI that dies before the turn's input is written gives back the prompts steered behind it.** Its input queue is FIFO, so they are unwritten too. `end()` returns them as `unread`, and the queue ends up as the batch, those prompts, then the rest.
- **`steer` returns the session's answer for `!` and spell steers instead of `true`.** `src/core/coordinator.ts:393-396` ignores it. A `!` row still shows before its steer, because the command's output starts at once. Claude can't refuse it while `replied` holds (`src/agents/claude.ts:588-598`).
- **Coordination with #297.** Pr #297 (draft, not merged at `68ff1aa`) adds `this.snapshot.answering ||` to `steer`'s refusal. If it lands first, keep that refusal in `steer` ahead of the new paths, and keep its test that a prompt sent during an answer turn queues (`test/coordinator-peer-requests.test.ts`) passing.

## Global Constraints

- **Done when** `pnpm check` exits 0, `pnpm test:integration` prints the `PASS` line with Task 3's checks, and the pr is open.
- **Branch and commits.** Work on branch `fix/steer-slash-prompts` from `main` at `68ff1aa`. Merge `main`, never rebase. Load `commit-message` before each commit and `pr-writing` before the pr text.
- **Imports.** Relative imports end in `.js`, and type-only imports use `import type`.
- **Checks.** The pre-commit hook runs only `pnpm lint`. Each task formats its files with `pnpm exec prettier --write <files>`, then runs `pnpm typecheck && pnpm lint`.
- **Test order.** Tasks 1 and 2 change no tests. Task 3's live check confirms the fix before Task 4 edits tests, in their own commit.
- **Usage.** Task 3 spends account usage on both native logins. Confirm with the user before running it.
- **Execution.** Tasks 1 to 3 run directly in this checkout. Task 4 edits more than five test files that no other task touches, so it gets its own implementer (`opus`) with this plan and the ownership context: #302 is claimed by this checkout's session. The implementer doesn't commit.
- **Writing.** Code comments follow the surrounding lowercase voice. `docs/rules.md` keeps its sentence case.

## Review Focus

1. **Leading spaces and later lines.** `  /var/folders/xx/a.png\nwhat is this` is an ordinary prompt, and Claude marks it `client_composed`; its check trims first, as the CLI's does. Tests: N1, N8.
2. **A path whose first segment is a listed spell.** `/review/notes.md is stale`, with `review` listed, is ordinary with no skill call, because the name ends at whitespace. Test: N1.
3. **An interrupt while Claude holds a steered spell.** The spell comes back unread and runs next as its own turn with its skill call, once. Test: N3b.
4. **`/clear` or `/effort high` sent mid-turn.** Each steers as text and never runs natively. Tests: `test/claude.test.ts:50` (neither is listed), N1 (the coordinator steers it as a prompt), N8 (Claude marks it `client_composed`).
5. **A Codex spell queued mid-turn with a prompt after it.** The prompt steers, and the spell runs alone next with its skill item. Tests: N2, N11.

---

### Task 1: List native commands and run steered commands natively

**Files:**
- Modify: `src/agents/types.ts:12-23` (`Skill`, `SkillCall`), `:202-206` (`replied`), `:225-233` (`steer`)
- Modify: `src/agents/claude.ts:197-209` (`skillsOf`), `:555-586` (`steer`), `:755-765` (`push`), `:1157-1187` (`end`)
- Modify: `src/agents/codex.ts:610-627` (`steer`)
- Modify: `src/ui/app.tsx:296`, `:611` (`/help`)
- Modify: `docs/rules.md:25`

**Interfaces:**
- Produces: `Skill.builtin?: true`, a Claude Code command that `/name args` runs natively and the composer doesn't offer.
- Produces: `SkillCall`, documented as a `/name args` prompt matched to a listed spell or native command.
- Produces: `AgentSession.steer(prompt: string, options?: { command?: string; skill?: SkillCall }): Promise<boolean>`. With `skill`, the prompt is that command, to run natively. Claude runs it once the current native turn ends, inside this turn. Codex can't run a steered skill and returns false.

- [ ] **Step 1: Update the types and their docs in `src/agents/types.ts`** as in Interfaces. In the `replied` doc at `:202-206`, drop the clause that it runs a steered spell, since a steered spell no longer needs the replied window. Keep the part about taking a command or a model change.
- [ ] **Step 2: In `skillsOf`, return one entry per name.**
  - A name any built-in row has gets the built-in row's fields and `builtin: true`. An unmarked row that a built-in shadows runs the built-in, so it adds nothing.
  - Leave out built-in `clear`, `effort` and `fast`, listed in a module constant. Its comment says they change the history or settings Witch tracks, so they go as text until Witch owns them.
  - Update the jsdoc.
- [ ] **Step 3: Give `push` a flag, `push(content, composed = false)`.** When the flag is set, the message gets `client_composed: true`.
- [ ] **Step 4: Change Claude's `steer` to take `{ command, skill }`.**
  - Refuse a `skill` while `!this.messageLifecycle && !this.replied`, with a comment that without acknowledgements Witch's turn could end before Claude runs the command.
  - Push a prompt that isn't a shell command with `composed` set to `!skill && prompt.trim().startsWith('/')`, with a comment that Claude holds a message shaped like a slash command until the turn ends, and a marked one joins the turn as text.
  - The `steered` entry stays `{ prompt, pending: true }`, so an unread receipt returns it.
- [ ] **Step 5: In `end()`, give back the prompts steered behind unwritten input.** When `inputUnsent` holds, the result also carries `unread`: the `prompt` of every pending `steered` entry, in order. Command replies have no `prompt` and add nothing. Spread `unread` only when it has entries, as `unreadContext` is, since `test/claude.test.ts:527-532` and `test/coordinator-claude.test.ts:207-214` compare the whole result.
- [ ] **Step 6: Have Codex's `steer` take `{ skill } = {}` and return false for a skill.** Its comment says Codex expands a skill only at turn start.
- [ ] **Step 7: Leave built-ins out of the composer's list in `src/ui/app.tsx:296`.** Filter on `!builtin` as well as `!claimed.has(name)`. In the `/help` text at `:611`, change "and nothing else is waiting" to "and nothing but a spell is waiting".
- [ ] **Step 8: In `docs/rules.md:25`, replace "Discover skills with Codex skills/list and Claude supportedCommands without its built-ins, and replace the list on Codex skills/changed and Claude commands_changed."** Use:

  > Discover skills with Codex skills/list and Claude supportedCommands, and replace the list on Codex skills/changed and Claude commands_changed. Claude's built-ins, apart from clear, effort and fast, are listed as native commands the composer doesn't offer; those three go to Claude as text because they change history or settings Witch tracks.
- [ ] **Step 9: Format and check.** Run `pnpm exec prettier --write src/agents/types.ts src/agents/claude.ts src/agents/codex.ts src/ui/app.tsx docs/rules.md && pnpm typecheck && pnpm lint`. Expected: exit 0.
- [ ] **Step 10: Commit** these five files and this plan, for example `fix(claude): run Claude's built-ins and steered spells natively`. `.gitignore:4` ignores `docs/superpowers/`, so add the plan with `git add -f`, as earlier plans were.

### Task 2: Steer slash-shaped prompts and what a queued turn leaves behind

**Files:**
- Modify: `src/core/prompts.ts:33-38` (`alone`)
- Modify: `src/core/coordinator.ts:340-356` (`send`), `:364-397` (`steer`), `:413-457` (`drain`), `:863-867` and `:936-940` (`performTurn`)
- Modify: `docs/rules.md:29`

**Interfaces:**
- Consumes: Task 1's `steer` options. `skillCall` matches built-ins because they are in `snapshot.skills`.
- Produces: `alone(prompt: string, skills: readonly Skill[]): boolean`. `performTurn` gains a fourth parameter, `sent?: () => void`.

- [ ] **Step 1: Make `alone(prompt, skills)` true for a prompt `skillCall` matches or a `!` command.** Its jsdoc says a listed spell or native command, or a `!` command, takes a turn alone, and any other `/` text, such as a path, is a prompt.
- [ ] **Step 2: In `send`, hold a prompt back when the queue holds anything `skillCall` doesn't match.** That is an ordinary prompt or a `!` command, so the new prompt keeps its place behind it. Otherwise steer as now. Make the check inside the `admitting.then` callback, against the queue at admission, so two sends that aren't awaited can't pass each other.
- [ ] **Step 3: In `steer`, drop the queue check, which `send` now owns.** After the phase, cancel and session checks:
  - A `!` command keeps its replied-only path with the row first, but returns `session.steer(...)`'s result.
  - A `skillCall` match steers `prompt.trimStart()` with `{ skill }`.
  - Anything else steers the prompt as typed.
  - Only the `!` path shows its row before steering. The others show it once accepted.
- [ ] **Step 4: In `performTurn`, add `sent?: () => void`.** Call it right after `session.send(...)` is invoked and before that promise is awaited (`:936-940`). A comment says why: called after an await, the steers it chains would queue behind an admission the turn's end is waiting for (`test/coordinator-turns.test.ts:841`).
- [ ] **Step 5: Change `drain`.**
  - Before `operate`, take the batch as today, using the current skills, and publish the queue without it. The batch is the first prompt alone if it is `alone`, and otherwise every prompt before the first `alone` one.
  - Inside `operate`, right after `connectForTurn`, re-split the batch with the connected session's skills. Put what no longer belongs to it back in front of the queue, so a spell queued while skills were unknown goes alone. Reassign `batch` to the shortened one, so the join and the `finally` use it.
  - For a batch that isn't a `!` command, pass `sent`. It sets `followers = this.admitting.then(() => this.steerQueued())` and `this.admitting = followers.catch(...)`.
  - Await `followers` in a `finally` around `performTurn`, still inside `operate`, and report any error. `finishActivity` and `save` can throw after `sent`.
  - Add no other await to the loop. The `finally` still puts an undelivered batch back at the front.
- [ ] **Step 6: Add `private async steerQueued(): Promise<void>`.**
  - It takes the queue up to its first `!` command out of the queue and steers each prompt in order with `steer`.
  - Every refused prompt goes back in front of the queue, in order.
  - Once an ordinary prompt is refused, it and the rest go back unsteered.
  - Its jsdoc says ordinary prompts queued behind a queued prompt join the turn it starts, and a `!` command and what follows it wait.
- [ ] **Step 7: Edit `docs/rules.md:29`.**
  - In the sentence starting "While a background familiar or workflow holds the turn open", drop "it also runs a spell as a turn of its own, and". A steered spell no longer needs that window.
  - Replace three sentences: the one starting "Any other prompt the turn can't take", the one starting "Steered raw, Claude Code would run", and the one starting "Queued, a slash command". Use:

  > Witch runs its own commands itself. Any other prompt that starts with `/` is a command only when its first word names a listed spell or native command; any other, such as a path, steers as a prompt, and Claude gets it as written. A spell or native command sent during a turn goes to the runtime once it can take it: Claude runs it after the current native turn within the same turn, and without message lifecycle only once the turn has replied. One the runtime refuses, as Codex does since it runs a spell only at a turn's start, waits in Witch's queue for a turn of its own without holding the prompts sent after it. Any other prompt the turn can't take waits in Witch's queue for a later turn: one the turn refuses, one sent behind a queued ordinary prompt or `!` command, one sent after an interrupt, or a `!` command outside the supported window. Queued, a spell, native command or `!` command goes alone, and the prompts before the next one go as one turn, a line each. Once a queued turn's prompt is sent, the prompts queued behind it steer into that turn; the prompts queued behind a `!` command wait for a turn after it.
- [ ] **Step 8: Format and check.** Run `pnpm exec prettier --write src/core/prompts.ts src/core/coordinator.ts docs/rules.md && pnpm typecheck && pnpm lint`. Expected: exit 0.
- [ ] **Step 9: Run `pnpm test`.** Expect failures from the tests under Task 4's "Expectations that change by design" and "Tests that use `/` to queue". Check any other failure against the design before Task 4. A regression gets a code fix here. A change the design causes joins Task 4's list, with its reason.
- [ ] **Step 10: Commit** these three files, for example `fix(core): steer prompts that start with a path, and stop holding prompts behind a queued spell`.

### Task 3: Live check against both runtimes

**Files:**
- Modify: `scripts/integration.ts`

- [ ] **Step 1: Write a project spell for each runtime.** After the project's `git init`, write `.claude/skills/witch-probe/SKILL.md` and `.agents/skills/witch-probe/SKILL.md` in `project`. Each has frontmatter `name: witch-probe` and a `description`, and a body telling the agent to include a random `spell-` marker in its reply.
- [ ] **Step 2: Add `steerPath()`, modeled on `steer()` (`scripts/integration.ts:98-122`).**
  - While a tool runs, send `/var/folders/witch-live/Screenshot 2026-10-26 at 2.52.19 PM.png also include <marker> in your final reply.`
  - Assert the phase is `running` and the queue is `[]` right after the send.
  - On Claude, assert the first assistant item after the tool row already includes the marker. A message Claude held back would be answered in a second reply, and Witch's lifecycle tracking would still keep the turn open for it, so only this tells joining the turn apart from being held. Codex can emit commentary first, so on Codex only log it.
  - Log which of the two happened.
  - Call it beside both existing `steer()` calls (`:139` for Codex, `:155` for Claude).
- [ ] **Step 3: Add `steerSpell()`, called beside `steerPath()` for each runtime.** While a tool runs, send `/witch-probe`, then `Also include <marker> in your final reply.`
  - **Claude:** the queue is `[]` after each send, and the turn's assistant text includes both the spell's marker and `<marker>`. That checks the spell ran, not only that it was accepted.
  - **Codex:** the queue is `['/witch-probe']` after each send, so the follow-up steered past the spell. Once idle, the replies include `<marker>` and, from the spell's own turn, the spell's marker.
- [ ] **Step 4: Add `steerBuiltin()`, Claude only.** While a tool runs, send `/context`. Assert the queue is `[]`, and that before idle an assistant item contains `Context Usage`, the heading the probe's output began with. That checks the built-in ran.
- [ ] **Step 4b: Add `builtinFirst()`, Claude only.** In a new conversation, send `/context` as its first turn, then ask for the native instruction marker. The marker reply shows the model saw the Witch context that went before the built-in, which `performTurn` records as delivered (`src/core/coordinator.ts:953-965`).
- [ ] **Step 5: Log the evidence.** Print each runtime's queue after each send and the reply tails. Add the new checks to the final `PASS` line.
- [ ] **Step 6: Ask the user to confirm the usage, then run `pnpm test:integration`.** Expected: the `PASS` line. If a runtime contradicts the Evidence section, stop and re-plan instead of adjusting the check.
- [ ] **Step 7: Commit** `scripts/integration.ts`.

### Task 4: Tests

**Files:**
- Modify: `test/fixtures/agent.ts`, `test/fixtures/claude.mjs`, `test/coordinator-turns.test.ts`, `test/coordinator-compaction.test.ts`, `test/coordinator-memory.test.ts`, `test/ui-prompts.test.ts`, `test/claude.test.ts`, `test/claude-background.test.ts`, `test/codex.test.ts`, `test/ui-composer.test.ts`

**Interfaces:**
- Consumes: Task 1's `steer` options and `Skill.builtin`. Consumes Task 2's behavior.
- Produces: `FixtureAgent.refuseSkillSteer = false` and `FixtureAgent.skillSteers: SkillCall[]`. The fixture's `steer` refuses a `skill` steer while `refuseSkillSteer` is set. It records the call in `skillSteers` only when it accepts it, and pushes the prompt to `steers` and `steered` like a plain steer, so an interrupt returns it unread.
- Produces: an `effort` built-in row beside `compact` in `test/fixtures/claude.mjs:239-250`'s command list.

**Timing.** The ungated fixture `send` ends its turn within a few microtasks (`test/fixtures/agent.ts:285-304`), so a test that expects steers into a queued turn holds that turn with a second `TurnGate`, assigned before the first gate opens, and asserts `steers` before opening it.

**Expectations that change by design** (in `test/coordinator-turns.test.ts` unless named):
- `:551`: send the listed `/review now`, the built-in `/context` (skill `{ name: 'context', description: 'Context', builtin: true }`), then `One` and `Two`. All four steer. `skillSteers` is the two calls, and the only turn is `Start`. Retitle.
- `:600`: replace `/clear` with the listed `/review` under `refuseSkillSteer`. The test still shows a command queued behind unread prompts going alone after them.
- `:624-668`: drop the `an unlisted slash command` row. N1 covers it.
- `:696`: replace `/clear` with a listed spell under `refuseSkillSteer`.
- `:726`: keep the two sends that aren't awaited, and wrap the session's `steer` to refuse only the first. `steers` is `[]`, the queue is `['/review now', 'One']`, and the turns are `Start`, then `'/review now\nOne'`. That keeps its check that two sends can't pass each other.
- `test/coordinator-compaction.test.ts:339`, the `completed` outcome: `later` steers into the `original` turn. `steers` is `['later']`, `inputs.slice(1)` is `['original']`, and there is one compaction.
- `:1110`: the listed spell's steer carries its skill call, and `/clear` steers as a prompt. Retitle.
- `test/claude.test.ts:50`: `skills()` gives `compact` once with the built-in row's fields and `builtin: true`, then `review`. `effort` is left out. The `commands_changed` event gives only `later`, since `clear` is left out. Retitle.

`:670` and `:874` pass unedited. `:670` keeps `refuseSteer` set throughout. `:874` sends during the `switching` phase, which `steer` refuses (`src/core/coordinator.ts:367`, `:519`).

**Tests that use `/` to queue.** In each, set `refuseSteer = true` on the agent running the turn before the mid-turn send; the assertions stay. They are `test/coordinator-turns.test.ts:579`, `:817` and `:1228-1319` (`/queued`), `test/coordinator-memory.test.ts:233`, and `test/ui-prompts.test.ts:77-124`.

**New tests,** each named by the regression it catches:
- **N1** (`coordinator-turns`), parameterized: "a prompt that starts with a path or names no listed command steers into the running turn". Skills are `[{ name: 'review' }]`. The prompts are:
  - the incident's `/var/folders/xx/Screenshot 2026-10-26 at 2.52.19 PM.png clicking on the "product-decisions.md" link produced this error`
  - `  /var/folders/xx/a.png\nwhat is this`
  - `/review/notes.md is stale`
  - `/clear`

  For each: `steers` is `[prompt]`, `skillSteers` is `[]`, the queue is `[]`, a user row shows the text, and the turns are only `Start`.
- **N2:** "a prompt sent behind a spell the turn refused steers past it, and the spell goes alone next". With `refuseSkillSteer`, `/review now` queues with no row, and `after` steers. The turns are `Start`, then `['/review now', { name: 'review', args: 'now' }]`.
- **N3b:** "a spell an interrupt leaves unread goes alone next with its skill call". Use `unreadOnInterrupt`. The spell is steered, then the turn is interrupted. The next turn is `['/review now', { name: 'review', args: 'now' }]`, and the spell is sent once.
- **N4:** "prompts queued behind a queued prompt steer into the turn it starts, and a `!` command and what follows wait".
  - During a gated `Start`, with `refuseSteer`, send `/review now` (listed), `B`, `!ls` and `C`.
  - Assign a second gate, clear `refuseSteer`, then open the first gate.
  - While the spell's turn is held, `steers` is `['B']` and the queue is `['!ls', 'C']`. Open the second gate.
  - The turns are `Start`, the spell with its call, then `!ls`, then `C`. `shells` is `['ls']`.
- **N4b:** "a spell refused behind a queued turn stays queued while the prompts after it steer". During a gated `Start` with `refuseSteer`, send `A`, `/review now` and `B`. Clear `refuseSteer`, set `refuseSkillSteer`, assign a second gate, then open the first. While `A`'s turn is held, `steers` is `['B']` and the queue is `['/review now']`. The turns are `Start`, `A`, then the spell.
- **N4c:** "an ordinary prompt refused behind a queued turn keeps the prompts after it behind it". As N4, with `B` and `C` behind the spell, and the session's `steer` wrapped to refuse `B`. `steers` is `[]`, and the turn after the spell is `'B\nC'`.
- **N5:** "a prompt sent behind a prompt the turn refused waits behind it". With `refuseSteer`, `A` queues. Clear `refuseSteer`, and `B` still queues. The turns are `Start`, then `A\nB`.
- **N6:** "a queued prompt that starts with a path joins the prompts after it in one turn". With `refuseSteer`, send `/var/folders/xx/a.png what is this`, then `B`. The turns are `Start`, then `'/var/folders/xx/a.png what is this\nB'`. This is the incident's Escape path, and it fails if `alone` still treats every `/` as a command.
- **N7:** "a turn whose input was never written puts its steered prompts back between the batch and the rest". A gated turn reports `inputUnsent` with `unread: ['follow']`. The queue is the batch, `follow`, then what was queued behind.
- **N8** (`claude-background`, which has lifecycle and `wire.jsonl`): "a steered prompt that starts with `/` goes `client_composed`, and a steered command goes as typed".
  - During a turn, steer `  /var/folders/xx/a.png\nwhat is this`, `/clear`, `/review now` with its skill call, and `plain`.
  - The first two steered wire messages carry `client_composed: true`, and the last two don't. The turn's own `initial` message comes before them.
- **N10** (`claude.test.ts`, no lifecycle): "without message lifecycle a command steer is refused until the turn has replied". During a turn, the skill steer returns false and `plain` returns true. Once the fixture's `reporting familiar` turn has replied, the skill steer returns true.
- **N11** (`codex.test.ts`, beside `:569`): "a steered spell is refused and Codex gets no turn/steer". During a held `'hold'` turn, `steer('/review', { skill })` returns false and `steer.json` is absent, while `steer('plain')` still returns true.
- **N12** (`ui-composer.test.ts`, beside `:261`): "the composer's list leaves out built-in commands". With skills `{ name: 'context', builtin: true }` and `review`, typing `/` lists `review` and not `context`.
- **N13** (`claude.test.ts`, beside "a dispatch failure reports its transport cause" at `:522`): "prompts steered behind input a dead CLI never wrote come back unread". Kill the child, `send('hello')`, then `steer('follow')`. The result has `inputUnsent: true` and `unread: ['follow']`.

- [ ] **Step 1: Change the fixtures** as in Interfaces.
- [ ] **Step 2: Apply the expectation changes and the queue setup above.**
- [ ] **Step 3: Add N1, N2, N3b, N4, N4b, N4c, N5 to N8, and N10 to N13.**
- [ ] **Step 4: Run the focused tests.** `pnpm exec vitest run test/coordinator-turns.test.ts test/coordinator-memory.test.ts test/ui-prompts.test.ts test/claude.test.ts test/claude-background.test.ts test/codex.test.ts test/ui-composer.test.ts`. Expected: pass.
- [ ] **Step 5: Run `pnpm check`.** Expected: exit 0.
- [ ] **Step 6: Commit** the test files, for example `test(core): cover steered paths, native commands and queued followers`.

### Task 5: Publish

- [ ] **Step 1: Run `simplify-changes` over the branch's diff.** Commit any fix it makes, then rerun `pnpm check`.
- [ ] **Step 2: Merge `origin/main` and rerun `pnpm check`.** If #297 has landed, apply the coordination decision. Its `runTurn` replaces `performTurn`'s `delivered` parameter with `TurnOptions` and owns connect and compaction, so `sent` becomes a `TurnOptions` field and the re-split moves into `runTurn`, for turns of kind `turn` only.
- [ ] **Step 3: Push and open the pr with `pr-writing`.** The body cites the Evidence section's CLI findings, Task 3's logged output and the built-in decision. It labels as static evidence the `still_queued` claim and the claim that `client_composed` costs only mention expansion.
- [ ] **Step 4: Delete this plan in a follow-up commit once the pr merges.**
