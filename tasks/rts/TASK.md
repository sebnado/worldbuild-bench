# RTS

Build **Ironvein**, a small-scale 3D real-time strategy game: two mining outposts race
to harvest crystal and destroy each other's headquarters across a desert basin.

## Concept

A claim war on a mineral frontier — every harvester diverted to the front line is
income you didn't bank.

- **Setting**: a rust-red desert basin scattered with glowing crystal veins; the two
  headquarters sit at opposite ends, with rock outcrops and dry gullies as landmarks
  and natural choke points between them.
- **Aesthetic**: warm ochre-and-rust terrain under a high sun, cut by the cyan glow of
  crystal veins; the player's units in one clear accent color, the enemy's in another —
  both factions readable at a glance from above.
- **Feel**: a brisk, small-scale skirmish where every unit matters — expand, harass,
  defend; decisions win the game, not clicks per minute.
- **Core loop**: send harvesters to a vein → bank crystal → build more units → skirmish
  over the richest veins → crack the enemy base before they crack yours.

The concept is fixed — interpret and execute it well rather than replacing it.

## Objective

Destroy the **enemy headquarters** before your own is destroyed. The battlefield is a
bounded arena with at least 4 crystal veins placed so that contesting the middle
matters. One resource (crystal), two unit types, one structure per side.

## Required mechanics

- **Camera**: top-down or isometric view panned with `WASD` (edge-of-screen pan is a
  plus), covering the whole battlefield; the camera must not leave the map.
- **Selection and orders**: left-click selects a unit, left-drag box-selects a group;
  right-click issues a context order — move to ground, harvest a vein, attack an enemy.
  Selected units are clearly highlighted.
- **Economy**: harvesters gather from crystal veins and auto-deliver to the HQ; veins
  visibly deplete. The HQ builds harvesters and warriors for crystal via on-screen
  buttons or hotkeys, with a visible build cost and short build time.
- **Combat**: warriors auto-attack enemies in range; units and HQs have health bars.
  Keep unit caps modest (~12 per side) so the fight stays readable and fast.
- **Enemy AI**: harvests crystal, builds units, and sends raids of escalating size at
  the player; it must defend its own HQ when attacked.
- **HUD**: crystal count, unit count/cap, production buttons with costs, and a clear
  alert when your units or HQ take damage.

## Win / lose

- **Win**: enemy HQ destroyed → victory screen with match time and a Restart control.
- **Lose**: your HQ destroyed → defeat screen with a Restart control.
- Restart fully resets the match (map, economy, units) without reloading the page.

## Controls

- `WASD` pan camera, left-click / left-drag select, right-click order,
  production via on-screen buttons (hotkeys `1`/`2` are a plus).
- Control hints visible on screen at all times.

## Shared constraints (apply to every task)

- The game must run entirely from **static files** in this workspace: open `index.html`
  from a plain static file server, no build step, no server-side code.
- **No external network requests** of any kind. Use only the bundled libraries under
  `./lib/` through the import map in the provided `index.html` — Three.js, and
  optionally the Rapier physics engine (see the `threejs-game` skill).
- Implement the **`window.__bench` telemetry contract** exactly as specified in the
  `bench-telemetry` skill (player = the camera focus point on the battlefield;
  entities = all units and structures on both sides). Scoring is capped without it.
- Target **60 fps** on a mid-range machine; use delta-time-based movement.
- Playable immediately: visible instructions, working restart, reachable win and lose
  states. Validate with the `test_game` tool before finishing.
