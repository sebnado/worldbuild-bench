# Physics Puzzle

Build **The Marble Works**, a 3D physics puzzle game: the player manipulates objects
under gravity to get a ball into a goal zone across a sequence of levels.

## Concept

A contemplative contraption puzzle set in a warm, sunlit workshop where a marble must
find its way home.

- **Setting**: each level is a tabletop diorama — platforms, ramps, and a clearly
  glowing goal basin, framed so the whole puzzle is visible from a slow orbiting
  camera.
- **Aesthetic**: cozy workshop palette — warm wood tones, brass and copper accents,
  soft daylight; clean readable geometry so the marble's possible paths are obvious at
  a glance.
- **Feel**: calm and iterative — study, place, release, watch, adjust; failure is cheap
  and informative, success is a satisfying chain of physics doing its thing.
- **Core loop**: inspect the level → aim or place props → release the marble → watch
  physics resolve → celebrate the goal (or reset and refine) → next level.

The concept is fixed — interpret and execute it well rather than replacing it.

## Objective

Complete **3 handcrafted levels**. In each level the player must guide a ball from its
spawn point into a clearly marked goal zone using physics: gravity, rolling, collisions
with placed objects, ramps, and platforms. Each level should introduce one new idea
(e.g. level 1 a simple ramp aim, level 2 a gap to bridge, level 3 a moving platform or
counterweight).

## Required mechanics

- **Physics**: hand-rolled (gravity, velocity integration, sphere-vs-box collision with
  bounce/roll) or built on the bundled Rapier engine — your choice. Either way, keep it
  stable (no tunneling at normal speeds, no jitter at rest). No external or
  network-loaded physics libraries: only what is bundled under `./lib/` plus your own
  code.
- **Interaction**: the player either (a) places/rotates a limited set of props (ramps,
  blocks) before pressing a "release ball" control, or (b) directly applies impulses to
  the ball — pick one scheme and make it obvious. Orbit/rotate camera to inspect the
  scene.
- **Level flow**: level indicator on the HUD ("Level 2/3"), per-level attempt counter,
  and a per-level reset that restores the level's initial layout.
- **Feedback**: the goal zone reacts visibly when the ball enters; a short celebration
  before the next level loads.

## Win / lose

- **Win**: all 3 levels completed → victory screen with total attempts, plus Restart.
- **Lose**: a level failed 5 times (ball falls out of bounds or comes to rest outside
  the goal) → defeat screen with Restart.
- Restart resets to level 1 without reloading the page.

## Controls

- Mouse to aim/place/orbit, `R` to reset the ball/level, `Space` to release the ball.
- Control hints visible on screen at all times.

## Shared constraints (apply to every task)

- The game must run entirely from **static files** in this workspace: open `index.html`
  from a plain static file server, no build step, no server-side code.
- **No external network requests** of any kind. Use only the bundled libraries under
  `./lib/` through the import map in the provided `index.html` — Three.js, and
  optionally the Rapier physics engine (see the `threejs-game` skill).
- Implement the **`window.__bench` telemetry contract** exactly as specified in the
  `bench-telemetry` skill (player = the ball; entities = interactive props).
  Scoring is capped without it.
- Target **60 fps** on a mid-range machine; use delta-time-based movement.
- Playable immediately: visible instructions, working restart, reachable win and lose
  states. Validate with the `test_game` tool before finishing.
