# FPS

Build **Hollow Hull**, a first-person 3D shooter: the player sweeps a derelict orbital
freighter sector by sector, destroying the rogue drone hive nodes that have taken it
over.

## Concept

A lone salvage marine boards a dead ship where the machines never received the shutdown
order.

- **Setting**: the interior of a derelict cargo freighter — three distinct sectors
  (hangar, cargo hold, reactor bay) joined by corridors and bulkheads; crates, pipes,
  and catwalk railings give each fight cover and shape.
- **Aesthetic**: retro-industrial sci-fi — dark hull metal under amber hazard lighting
  and teal emergency glow; drones read as sharp dark silhouettes with glowing eyes;
  muzzle flash and tracers make every shot legible in the gloom.
- **Feel**: fast and confident — smooth strafing, snappy aim, arcade gunplay; the
  pressure comes from drone swarms and dwindling health, not horror or ammo scarcity.
- **Core loop**: enter a sector → thin out its drones → destroy the hive node → the
  bulkhead opens → deeper into the ship → ship cleared, or die trying and restart.

The concept is fixed — interpret and execute it well rather than replacing it.

## Objective

Destroy **3 hive nodes**, one per sector, inside a coherent walkable ship interior the
player cannot leave. Each sector is guarded by drones; destroying its node opens the
bulkhead to the next sector.

## Required mechanics

- **Player**: first-person camera with mouse look (pointer lock on click) and WASD
  movement; `ArrowLeft`/`ArrowRight` must also turn the view as a keyboard-only
  fallback. Wall and prop collision — no walking through geometry, no leaving the hull.
- **Weapon**: one gun fired with left-click, with a visible crosshair, muzzle flash,
  and tracer or projectile, plus a short cooldown between shots. Hits produce visible
  feedback on the target.
- **Drones**: at least 12 across the three sectors (escalating per sector). They idle
  or patrol until the player gets close or opens fire, then pursue and deal damage
  (contact or short-range shots). Drones die to a fixed number of hits with a clear
  destruction effect.
- **Hive nodes**: one per sector, visually unmistakable, destroyed by multiple hits
  with a readable damage state; a destroyed node visibly opens the next bulkhead.
- **HUD**: health, node progress (e.g. "Nodes 1/3"), and hit/damage feedback, always
  visible.

## Win / lose

- **Win**: all 3 hive nodes destroyed → victory screen with completion time and a
  Restart control.
- **Lose**: player health reaches 0 → defeat screen with a Restart control.
- Restart fully resets to sector 1 without reloading the page.

## Controls

- `WASD` move, mouse to look (click the canvas to lock the pointer), left-click fire,
  `ArrowLeft`/`ArrowRight` turn (fallback).
- Control hints visible on screen at all times.

## Shared constraints (apply to every task)

- The game must run entirely from **static files** in this workspace: open `index.html`
  from a plain static file server, no build step, no server-side code.
- **No external network requests** of any kind. Use only the bundled libraries under
  `./lib/` through the import map in the provided `index.html` — Three.js, and
  optionally the Rapier physics engine (see the `threejs-game` skill).
- Implement the **`window.__bench` telemetry contract** exactly as specified in the
  `bench-telemetry` skill (player = the marine; entities = drones and hive nodes).
  Scoring is capped without it.
- Target **60 fps** on a mid-range machine; use delta-time-based movement.
- Playable immediately: visible instructions, working restart, reachable win and lose
  states. Validate with the `test_game` tool before finishing.
