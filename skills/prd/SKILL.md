---
name: prd
description: Write PRD.md before any code — spawn a dedicated PRD subagent to produce an exhaustive, technically deep requirements document that raises the game far above the brief's minimum. Every build task derives from it.
---

# The PRD: Design the Whole Game Before Building Any of It

The task brief (TASK.md) is a **floor, not a ceiling** — it lists the minimum mechanics
that must exist. Games built straight from the brief come out as thin prototypes. The
builds that score well design first: an exhaustive PRD, then a build plan derived from it.

**Delegate this.** Your first action as orchestrator should be one `spawn_agent` call
that produces `PRD.md`. A dedicated PRD agent with fresh context goes deeper than a
planning paragraph ever will.

## Spawning the PRD agent

The PRD agent has no context — its brief must say where to look and what to produce:

```
Write PRD.md — the complete product requirements document for the game this
workspace will build. Read TASK.md (the task brief: hard requirements),
skills/game-quality/SKILL.md (the quality bar), skills/world-design/SKILL.md
(spatial design), and skills/threejs-game/SKILL.md (technical constraints)
first. Write ONLY PRD.md; do not write any code.

The brief is the minimum. Design the most ambitious game a strong team could
ship in this workspace: production quality, not a prototype. Follow the section
list in skills/prd/SKILL.md exactly. Be concrete everywhere — numbers, not
adjectives; named techniques, not aspirations. A thorough PRD is longer than
one reply's output limit — write it in sections: write_file the first sections,
then write_file with append: true for each following batch. Reply with a
10-line summary of the design's pillars and its riskiest technical bets.
```

## Required PRD sections

1. **Vision & pillars** — one paragraph of player fantasy; 3 pillars every later
   decision must serve (e.g. "motion you can feel", "a world that orients you").
2. **Core loop** — moment-to-moment, per-round, per-session. What the player does,
   what pushes back, what rewards them, why they retry.
3. **Mechanics spec** — every mechanic with tuned numbers: speeds, accelerations,
   cooldowns, timings, curve shapes, and any other tuned values the brief implies.
   A builder must be able to implement from this section without inventing values.
4. **Systems design** — each runtime system (world, player, AI/NPC, interaction,
   camera, HUD, audio, fx, game flow): data model, update algorithm, and the
   named technique/algorithm it uses, chosen from the state of the art. A system
   described only as "basic meshes + keyboard input" is a prototype spec.
5. **Content & world layout** — the actual content: play-space layout described
   region by region *with its spatial reasoning* per the world-design skill —
   landmarks and orientation, sightlines, density rhythm, what the gameplay
   camera sees at the key moments — plus entity/content roster with distinct
   behaviors, progression and difficulty ramp, variety the player will actually
   notice.
6. **Visual direction** — palette (hex values), lighting design (direct and
   indirect/environment strategy, shadow approach), sky/environment treatment,
   material strategy (how surfaces get texture and wear, not just base colors),
   post-processing chain (which passes, in what order), particle effects list,
   silhouette rules for readable geometry.
7. **Audio direction** — first the direction: a sonic palette matched to the
   visual direction (what does this world sound like?), how intensity follows
   game state (layers/tempo rising with the stakes), the mix hierarchy (what
   ducks under what), and where silence does the work. Then the WebAudio
   synthesis plan that realizes it: engine/ambient bed, event SFX list with a
   synthesis recipe per sound (oscillator type, envelope, filter), music
   approach. No external audio files exist — everything is synthesized.
8. **UI/UX** — every screen and state (menu/countdown/playing/paused/won/lost),
   HUD element inventory with placement, feedback rules (what flashes, shakes,
   or pops when — see game feel in the game-quality skill).
9. **Technical architecture** — module list with exact file paths, the complete
   `gameState` contract (every key, its type, who writes it, who reads it),
   module exports with signatures, init and update order. The orchestrator freezes
   this section into stub files before any builder runs, and it is immutable during
   the parallel build — so make every export name and signature complete and final
   here. This section is the source of truth the orchestrator's builder briefs
   quote from.
10. **Performance budget** — target 60 fps: draw-call ceiling, instancing plan,
    geometry/texture budgets, pixel-ratio clamp, what degrades first.
11. **Acceptance criteria** — a checklist merging (a) every hard requirement in
    TASK.md, (b) the `window.__bench` telemetry contract, (c) the PRD's own
    quality commitments. Phrased as verifiable statements.
12. **Build plan** — tasks grouped by dependency (group 1 has no dependencies,
    group 2 builds on group 1, …), each task with: file ownership, exports,
    gameState keys touched, and its acceptance criteria from §11. One task ↔ one
    future builder subagent.

## Quality tests for the PRD

- Someone who never read TASK.md could build the full game from PRD.md alone.
- Every system in §4 names at least one concrete technique — a PRD whose systems
  are all "basic meshes + keyboard input" is a prototype spec, rejected.
- §12 tasks are disjoint (no two tasks own the same file) and cover every file
  in §9.
- Nothing contradicts the hard constraints: static files only, no network, bundled
  Three.js only, telemetry contract intact.

## After the PRD lands

The orchestrator (you) reads PRD.md critically before building: fix contradictions,
cut whole features cleanly rather than shipping every feature half-done, then
execute §12 with builder subagents per the subagents skill. Keep PRD.md updated if the design changes mid-build; it
is the reference every later builder brief quotes.
