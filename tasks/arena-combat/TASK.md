# Arena Combat

Build **Last Stand at the Ruin**, a wave-based 3D arena combat game: the player fights
escalating waves of melee enemies inside a closed arena until every wave is cleared or
the player dies.

## Concept

A lone fighter defends a torch-lit ruined courtyard against creatures pouring in from
the dark.

- **Setting**: a crumbling walled courtyard at night — broken columns, rubble piles,
  and a handful of burning torches as landmarks; beyond the walls, darkness.
- **Aesthetic**: high-contrast night scene — warm torch and ember light against cool
  moonlit stone; enemies read as clear dark silhouettes with glowing eyes so the
  player can track a whole crowd at a glance.
- **Feel**: tense but readable crowd control — kite, turn, swing; each wave should feel
  barely survived, with health as the pressure gauge.
- **Core loop**: wave banner → fight and thin the crowd → clear the wave → short
  breather → bigger wave → victory, or a defeat worth avenging via Restart.

The concept is fixed — interpret and execute it well rather than replacing it.

## Objective

Survive and clear **3 waves** of enemies in a walled arena roughly 40×40 units.
The arena must read as a coherent space: floor, boundary walls the player cannot leave,
and enough visual landmarks to orient by.

## Required mechanics

- **Player**: third-person or top-down character moved with WASD, camera following
  smoothly. A visible attack (melee swing or projectile) triggered with Space or
  left-click, with a short cooldown.
- **Enemies**: spawn at the arena edges in 3 waves (suggested 5 / 8 / 12). They pursue
  the player and deal contact damage. Enemies die to a fixed number of player hits and
  visibly disappear (or play a death effect).
- **Health and score**: player health (100, contact damage ~10) and a kill score,
  both always visible on the HUD.
- **Wave flow**: a short banner announces each wave; the next wave starts when the
  current one is cleared.

## Win / lose

- **Win**: all 3 waves cleared → victory screen with final score and a Restart control.
- **Lose**: player health reaches 0 → defeat screen with a Restart control.
- Restart fully resets the game to wave 1 without reloading the page.

## Controls

- `WASD` move, `Space` (and/or left-click) attack.
- Control hints visible on screen at all times.

## Shared constraints (apply to every task)

- The game must run entirely from **static files** in this workspace: open `index.html`
  from a plain static file server, no build step, no server-side code.
- **No external network requests** of any kind. Use only the bundled libraries under
  `./lib/` through the import map in the provided `index.html` — Three.js, and
  optionally the Rapier physics engine (see the `threejs-game` skill).
- Implement the **`window.__bench` telemetry contract** exactly as specified in the
  `bench-telemetry` skill. Scoring is capped without it.
- Target **60 fps** on a mid-range machine; use delta-time-based movement.
- Playable immediately: visible instructions, working restart, reachable win and lose
  states. Validate with the `test_game` tool before finishing.
