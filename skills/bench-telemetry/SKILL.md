---
name: bench-telemetry
description: The REQUIRED window.__bench telemetry contract — getState, reset, getPlayerPosition, getCameraInfo, getEntities, getObjectiveStatus — with the exact shape to implement. Games without it are score-capped.
---

# The window.__bench Telemetry Contract (REQUIRED)

Your game is scored by scripted probes that call `window.__bench`. If the
object or any method is missing, the Playability Score is capped and the World Coherence
Score cannot be earned. Implement it early — it is a few lines once your `gameState`
exists — and keep it working as the game grows.

## Exact shape

Attach this in your main module after the game initializes:

```javascript
// js/bench.js (or inline in main.js) — wire to your real gameState
import * as THREE from 'three'; // already mapped by the scaffold's import map

export function installBench(gameState, player, camera, restartGame) {
  window.__bench = {
    // Full serializable snapshot of the game state. Plain data only —
    // no THREE objects, no functions, no cycles (it must survive JSON.stringify).
    getState() {
      return {
        phase: gameState.phase,            // 'menu' | 'playing' | 'won' | 'lost'
        score: gameState.score,
        health: gameState.player.health,
        entities: gameState.entities.length,
      };
    },

    // Restart to the initial state (same as the player pressing Restart).
    // After reset(), getState() and getPlayerPosition() must return values
    // matching a fresh load.
    reset() {
      restartGame();
    },

    // World-space player position as {x, y, z} finite numbers.
    // Return the controlled avatar/object root (or the camera focus point if
    // that better represents "where the player is").
    getPlayerPosition() {
      const p = player.root.position;
      return { x: p.x, y: p.y, z: p.z };
    },

    // Camera position + look direction, finite numbers.
    getCameraInfo() {
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      return {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        direction: { x: dir.x, y: dir.y, z: dir.z },
        fov: camera.fov,
      };
    },

    // Every live gameplay entity (NPCs, pickups, interactables, etc.).
    // Empty array is valid when nothing is alive.
    getEntities() {
      return gameState.entities.map((e) => ({
        id: e.id,
        kind: e.kind,                      // short string label for the entity type
        position: { x: e.root.position.x, y: e.root.position.y, z: e.root.position.z },
      }));
    },

    // Progress toward the win condition, plus the outcome flags.
    getObjectiveStatus() {
      return {
        objective: 'complete the objective', // human-readable current objective
        progress: gameState.progress,        // 0..1 fraction toward win
        won: gameState.phase === 'won',
        lost: gameState.phase === 'lost',
      };
    },
  };
}
```

## Rules the probes check

- All six methods exist and are functions on `window.__bench`.
- Every method returns synchronously with JSON-serializable data (no Promises).
- No method throws, in any game phase (menu, playing, won, lost).
- `getPlayerPosition()` returns finite `{x, y, z}` — no NaN, no infinite falling
  (y should not run away to -infinity).
- The camera stays within a sane distance of the player.
- The state returned by `getState()` evolves over time while playing, and
  `reset()` genuinely restores the initial state and position.

Test the contract yourself with the `test_game` tool — its report has a
`bench_contract` section showing exactly which methods were found and what each
returned.
