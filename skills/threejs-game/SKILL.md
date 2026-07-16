---
name: threejs-game
description: How to structure a Three.js game in this workspace — import map usage, modular file layout, the shared gameState contract, the THREE.Group wrapper pattern, and the static-file constraints every game must respect.
---

# Building a Three.js Game in This Workspace

## Library and imports

Three.js and its full addons tree are pre-installed under `lib/three/`. The provided
`index.html` contains an import map — use it as your starting point, do not recreate it.

Import with these exact specifiers (they resolve via the import map):

```javascript
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
```

Rules:

- Never load Three.js (or anything else) from a CDN. No external network requests at all —
  no remote fonts, textures, analytics, or scripts. The game must run fully offline.
- All asset and script paths must be **relative** (`./js/player.js`, `./assets/tex.png`).
  Absolute paths break when the game is served from a subdirectory.
- No build step. The game runs by serving the workspace directory as static files and
  opening `index.html`. ES modules only — no bundlers, no `require`.
- The whole `examples/jsm/` addons tree is available: controls, loaders, postprocessing,
  math, geometries, and the wasm helpers under `libs/`. List `lib/three/examples/jsm/` to
  discover modules; import them directly via the `three/examples/jsm/` alias.
- The Rapier physics engine is also bundled (optional): `import RAPIER from
  '@dimforge/rapier3d-compat';`. Call `await RAPIER.init()` once before any physics API —
  the WASM must initialize, and forgetting this is the classic failure. Step the
  simulation with a fixed timestep decoupled from the render loop. Hand-rolled physics
  remains an equally legitimate choice.

## Module structure

Split the game into focused modules with one clear responsibility each. A typical layout:

```
index.html          # provided — import map + <script type="module" src="./js/main.js">
js/
  main.js           # bootstrap: create scene/camera/renderer, init modules, run the loop
  world.js          # terrain / level geometry, environment, lighting
  player.js         # player entity, movement, input handling, camera follow
  actors.js         # NPCs, hazards, or other interactive entities (if any)
  gameLogic.js      # rules: scoring, win/lose conditions, progression
  ui.js             # HTML/CSS overlay HUD: status, score, instructions, end screens
css/style.css       # layout and HUD styling
assets/             # any generated textures/models (optional)
```

Each module exports at minimum:

```javascript
export function init(scene, gameState) { /* create objects, attach listeners */ }
export function update(dt, gameState)  { /* advance one frame; dt in seconds */ }
```

`main.js` imports every module, calls `init` in dependency order, then drives a single
`requestAnimationFrame` loop that computes delta time once and passes it to every
module's `update`. Keep input sampling, logic updates, and rendering as separate phases
inside the loop.

## The shared gameState contract

Modules never reach into each other's internals. They communicate through one shared,
plain-object `gameState` created in `main.js` and passed to every module:

```javascript
export const gameState = {
  phase: 'playing',            // 'menu' | 'playing' | 'won' | 'lost'
  score: 0,
  player: { position: new THREE.Vector3(), health: 100, velocity: new THREE.Vector3() },
  entities: [],                // live interactive objects: { id, kind, root }
  input: { keys: {}, pointer: { x: 0, y: 0, down: false } },
};
```

Decide up front which module *writes* each key and which modules only *read* it, and
keep to that. Example: `player.js` writes `gameState.player.position`; `actors.js`
reads it for targeting or proximity; `ui.js` reads everything and writes nothing.

This same object is what your `window.__bench.getState()` should serialize — see the
`bench-telemetry` skill.

## The THREE.Group wrapper pattern

Always wrap every game object in a parent `THREE.Group`, even a single-mesh placeholder.
Apply all gameplay transforms (position, rotation, scale) to the group — never to the
child meshes:

```javascript
const entityRoot = new THREE.Group();          // gameplay code references ONLY this
entityRoot.add(new THREE.Mesh(
  new THREE.BoxGeometry(2, 1, 4),
  new THREE.MeshStandardMaterial({ color: 0xcc3333 }),
));
scene.add(entityRoot);

entityRoot.position.x += speed * dt;        // correct: move the root
// mesh.position.x += speed * dt;           // wrong: never move the child mesh
```

Why: real models have internal hierarchies (body, limbs, attachments). With a root
group, gameplay code stays identical whether the child is a box placeholder or a
loaded model, and bounding-box math stays predictable.

## Gameplay and UX baseline

- Show visible control instructions on screen (e.g. "WASD to move — Space to act").
  Prefer keyboard-first controls; the automated playtest presses WASD/arrows/Space.
- The game must be playable immediately on load (or after one obvious click/keypress).
  Hide any loading screen only after every system is initialized; surface errors visibly.
- Make win and lose states reachable and show a clear end screen with a restart path.
- Target 60fps: reuse geometries/materials, pool frequently spawned objects, keep
  per-frame allocations near zero, use delta time everywhere so speed is framerate-independent.
- Verify collisions and triggers actually connect (hits register, objectives advance) —
  this is the most common class of broken game.
- Verify control directions from the player's seat, not just that keys do something:
  pressing A must visibly move left *on screen*. Left/right sign inversions relative
  to the camera are a near-universal bug, and players feel them instantly.
