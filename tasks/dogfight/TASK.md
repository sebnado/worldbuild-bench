# Dogfight

Build **Archipelago Aces**, a 3D arcade dogfighting game: the player flies a seaplane
against two flights of enemy aircraft above a scattered island chain, where the sea
below is as deadly as the guns behind you.

## Concept

A postcard sky turned battlefield — bank hard around the sea stacks, get on their six,
and don't watch the water too long.

- **Setting**: a bright island chain — turquoise shallows, sandy islets, a lighthouse
  and tall sea stacks as landmarks to bank around; scattered clouds give the sky depth
  and something to dive through.
- **Aesthetic**: sunny, saturated low-poly — postcard blues and warm sand greens; the
  player's seaplane in cream-and-teal, enemies in unmistakable crimson; tracers and
  contrails make every plane's path readable mid-turn.
- **Feel**: swoopy arcade flight — banking turns, dives that trade altitude for speed,
  the satisfaction of holding a lead just long enough; danger comes from overcommitting
  toward the ocean as much as from enemy fire.
- **Core loop**: spot the flight → turn, chase, line up the shot → down them one by one
  → the second flight arrives meaner → clear the sky, or splash and go again.

The concept is fixed — interpret and execute it well rather than replacing it.

## Objective

Shoot down **6 enemy aircraft**, arriving as two flights of 3 (the second flight more
aggressive), while staying airborne. The ocean is a hard floor: flying into it destroys
the player instantly. A soft boundary must keep the fight over the archipelago (turn
the player back or steer them around — no invisible walls that stop the plane dead).

## Required mechanics

- **Flight model**: arcade — the plane always moves forward; pitch and turn with
  arrows/WASD (mouse steering is a plus), throttle up/down on two keys, banked visual
  roll in turns. Momentum should be felt; stalling simulation is not required.
- **Camera**: smooth chase camera behind the plane that keeps the horizon readable
  through turns and dives.
- **Guns**: fire with `Space` (and/or left-click) with visible tracers and a short
  spin-up or heat limit so holding fire forever is discouraged. Hits flash or smoke;
  a downed plane falls with a smoke/fire trail before despawning.
- **Enemy AI**: enemies pursue the player, fire when roughly aligned, and break off or
  evade when damaged; they must also avoid crashing into the sea. Second flight is
  faster or more aggressive than the first.
- **HUD**: player health, enemies remaining, throttle/speed indicator, and an on-screen
  indicator pointing toward the nearest enemy when none are on screen.

## Win / lose

- **Win**: all 6 enemies downed → victory screen with mission time and a Restart
  control.
- **Lose**: player health reaches 0, or the player hits the ocean → defeat screen with
  a Restart control.
- Restart fully resets the mission (both flights, health, position) without reloading
  the page.

## Controls

- Arrows or `WASD` pitch/turn, `W`/`S` or `Shift`/`Ctrl` throttle (state your mapping
  in the hints), `Space` and/or left-click fire.
- Control hints visible on screen at all times.

## Shared constraints (apply to every task)

- The game must run entirely from **static files** in this workspace: open `index.html`
  from a plain static file server, no build step, no server-side code.
- **No external network requests** of any kind. Use only the bundled libraries under
  `./lib/` through the import map in the provided `index.html` — Three.js, and
  optionally the Rapier physics engine (see the `threejs-game` skill).
- Implement the **`window.__bench` telemetry contract** exactly as specified in the
  `bench-telemetry` skill (player = the player's aircraft; entities = all aircraft).
  Scoring is capped without it.
- Target **60 fps** on a mid-range machine; use delta-time-based movement.
- Playable immediately: visible instructions, working restart, reachable win and lose
  states. Validate with the `test_game` tool before finishing.
