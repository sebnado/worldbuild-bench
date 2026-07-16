---
name: subagents
description: The orchestrator playbook — run the build like a tech lead; PRD agent first, then parallel module builders with strict file ownership, then integrate, playtest, and run a dedicated polish pass.
---

# Orchestrating the Build with Subagents

You are the orchestrator, not the sole builder. `spawn_agent` gives you focused
workers with fresh context in the same workspace; your own turns are for
architecture, contracts, integration, review, and playtesting. Run it like a
studio: design → build in parallel → integrate → polish. Used badly (vague briefs,
overlapping files) it produces merge chaos — the rules below prevent that.

## The pipeline

**Phase 1 — PRD.** Spawn a dedicated PRD agent to write `PRD.md` per the `prd`
skill. Read it critically when it lands: fix contradictions, cut anything you
cannot ship at full quality, and treat its §12 build plan as your task list.

**Phase 2 — Freeze the contract (your most important turn).** This is what lets
builders run in parallel without fighting each other. Before delegating anything,
write the interface surface as real code, from PRD §9:
- `js/main.js` — real code: the full `gameState` object (every key), the import
  list, init order, and the game loop calling each module's
  `update(dt, gameState)`. Put a camera, a light, and a ground plane in the scene
  so the empty game renders a non-black frame.
- A **stub for every other module** — each exporting exactly the functions PRD §9
  lists, with the exact signatures, and a correct empty body (return a
  `THREE.Vector3`, an empty array, a no-op) so the module loads. Head each stub
  with: `// CONTRACT (frozen): these exports and signatures are law. Implement the
  bodies only — do not add, remove, rename, or re-sign any export.`

Run `test_game` and confirm the empty game **loads and renders** before you spawn a
single builder. This frozen surface is the contract: from here until integration no
file's export set changes. If building later proves the contract wrong, **you**
change it centrally and re-stub — a builder never edits an interface. It is the same
discipline a single developer keeps by changing a function and its callers together;
fixing the interface up front is how you enforce it across concurrent workers.

**Phase 3 — Parallel builders fill the stubs.** One builder per PRD §12 task, each
owning exactly one file. Issue a group's `spawn_agent` calls in **one reply** — they
run concurrently. Because every interface is already frozen and stubbed, they cannot
collide: each replaces its own stub's bodies while every export the others call
stays put. A builder implements the bodies of its file's already-declared exports,
keeps every name and signature exactly, edits no other file, and does **not** run
whole-game `test_game` (siblings are editing concurrently — a whole-game test
mid-group reports races, not real bugs; it smoke-checks its own file with
`node --check`). A builder that finds the contract wrong STOPS and reports to you
rather than fixing the interface. Wait for the whole group, then `read_file` the
exports to confirm the surface is intact before the next group.

**Phase 4 — Integrate and test at the barrier (yours alone).** Only you run
whole-game playtests (`test_game` / `play_game`), and only between groups and after
integration. Fix interface mismatches, wire cross-cutting flows (collision → damage →
feedback → UI → game over), and install the `window.__bench` telemetry. After
integration, verify mechanics causally with `play_game` — script the core loop's
inputs and confirm each produces the state change the brief requires (see the
`playtest` skill). Small fixes: edit directly — never re-spawn a builder for a
two-line fix.

**Phase 5 — Polish pass.** After the game works end-to-end, run dedicated polish
builders — this is where a working game becomes a great one: one for game feel
(camera, tweens, hit feedback per the `game-quality` skill), one for audio, one
for visual dressing (lighting, particles, post-processing). Playtest after each.
Polish agents run one at a time (or with strictly disjoint files); an agent
running alone may be told in its brief to run `test_game` / `play_game` — the
builder no-test rule exists only to avoid mid-group races, and a solo agent has no
group.
Always end with your own final integration and validation pass — never finish the
run on an untested change.

## Writing a good builder brief

Each subagent starts with **no context** — it has not seen TASK.md, PRD.md, or your
plan. Its brief must be self-contained; quote the relevant PRD sections into it:

```
Implement js/enemies.js for a wave-based arena combat game (Three.js, ES modules,
import map already set up: import * as THREE from 'three'). The file already
exists as a frozen stub — its exported names and signatures are the contract.
Fill in the bodies; keep every export exactly as declared. Read PRD.md §4
"Enemy system" and §5 "Enemy roster" and implement that spec, and read
skills/game-quality/SKILL.md for the quality bar (pooled particles on death,
squash tween, pitch-randomized SFX hook via gameState.audio.play('hit')).

You own ONLY js/enemies.js. Do not create, edit, or rename anything outside it,
and do not add, remove, rename, or re-sign any export. If the stub's contract
looks wrong or insufficient, STOP and report it — never change the interface.

Exports (already declared in the stub — implement these bodies):
  initEnemies(scene, gameState)  — set up spawning for wave 1
  updateEnemies(dt, gameState)   — spawning, pursuit AI, attack logic

Contract: read the player's position from gameState.player.position (a
THREE.Vector3 kept current by player.js). Push each live enemy into
gameState.entities as { id, kind: 'enemy', root } and remove it on death.
Write nothing else to gameState except gameState.entities and
gameState.score (+10 per kill).

Every enemy must be a THREE.Group root with meshes as children; all movement
applies to the root. Validate your file with `node --check js/enemies.js` — do
NOT run test_game (the game is mid-build and siblings are still editing). Reply
with a summary of the exports as implemented, the techniques you used, and any
assumptions you made.
```

The essentials every brief needs: game context in one paragraph, the PRD sections
to read, exact file ownership, the frozen exports it must implement (never change),
the gameState keys it may read and write, the quality bar expected of it, the
instruction to self-check with `node --check` and not run whole-game `test_game`,
and what to report back.

## Rules

- **One file set per builder, no overlaps.** Two agents writing the same file is
  the worst failure mode of this approach. The PRD §12 ownership map is law.
- **The frozen contract is law.** Export names and signatures are set in Phase 2;
  only you change them, centrally, by re-stubbing. Builders implement bodies — a
  builder that renames or re-signs an export breaks every sibling that imports it.
  Freezing the interface up front is exactly what makes concurrent building as safe
  as one developer working sequentially.
- **Whole-game playtests (`test_game` / `play_game`) are the orchestrator's, at
  group barriers.** A builder running one mid-group tests a half-updated tree and
  reports races as bugs; builders self-check only their own file with `node --check`.
  (Exception: an agent running alone — e.g. a Phase 5 polish agent — may be granted
  playtest tools in its brief.)
- Subagents can spawn their own helpers only one level deeper — keep the tree
  shallow: orchestrator → builders → (rarely) one helper.
- You may write code directly for glue, fixes, and telemetry — but if you find
  yourself implementing a whole system inline, stop and delegate it.
- Only for genuinely trivial games (fewer than ~3 distinct systems) is skipping
  orchestration acceptable — and these tasks are never that.
