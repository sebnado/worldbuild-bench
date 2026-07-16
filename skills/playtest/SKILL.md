---
name: playtest
description: How and when to use the test_game and play_game tools — reading the health report, scripting interactive gameplay sessions to verify cause and effect, and the common failure signatures with their usual fixes.
---

# Playtesting with test_game and play_game

Two tools, two jobs. `test_game` is the standardized health check — the same fixed
probe the scoring gates mirror. `play_game` is you at the keyboard: script a sequence
of clicks and key presses, and read the game state after every action. Use `test_game`
to find out *whether the game runs*; use `play_game` to find out *whether the game
plays* — that each mechanic causes the state change the design intends.

`test_game` serves your workspace on a local port, loads `index.html` in a headless
browser for ~15 seconds, and returns a JSON report. It is your only window into whether
the game actually runs — use it:

1. **Right after scaffolding** — catch import-map/path mistakes before writing gameplay.
2. **After each major module lands** — a broken module found late is expensive.
3. **Before declaring the task done** — the final score comes from the same probe.

Run it via a tool call (optionally `{"page": "other.html"}`; default `index.html`).
It costs nothing but ~20 seconds of wall clock. Do not "save it for the end".

## Reading the report

| Field | Meaning | If it's bad |
|---|---|---|
| `loaded` / `load_error` | The page load event fired | Syntax error in an early script, missing file, or infinite loop during init |
| `console_errors`, `page_errors` | Uncaught exceptions + console.error output | Fix every one — the score penalizes any fatal error. 404s show up here as failed fetches |
| `canvas.count`, `canvas.has_webgl_context` | A canvas exists and has a WebGL context | Renderer never constructed, or constructed after a crash |
| `rendering.visibly_renders_at_2s/_10s` | Screenshot is not blank/black (luminance variance + distinct colors) | Scene renders but everything is black: add lights, check camera position/lookAt, check background vs geometry contrast |
| `fps.avgFps` | requestAnimationFrame rate over ~2s | Below ~25: too many draw calls, per-frame allocations, or shadow-map abuse |
| `input_probe` | Clicks the canvas, then presses w/ArrowUp/a/d/Space | `player_moved`/`bench_state_changed` false: input listeners not attached, wrong key names, or game stuck on a menu that needs a specific button |
| `bench_contract` | Which `window.__bench` methods exist and what they returned | See the `bench-telemetry` skill — this is required |
| `coherence_probes` | Position sanity, camera sanity, entity queries, state evolution, reset behavior | These map 1:1 to World Coherence scoring gates |

## Common failure signatures

- **`loaded: false` with no errors** — usually a top-level `await` that never resolves,
  or an asset `fetch` to a missing path blocking init.
- **Black screenshot, no errors** — camera inside geometry, no lights with
  `MeshStandardMaterial`, or scene background identical to unlit meshes. Add an
  `AmbientLight` + `DirectionalLight` and re-test.
- **`input_probe` all false, game shows a start menu** — the probe clicks the canvas
  center once, then presses keys. Make the game start on canvas click or any key, not
  only on a specific DOM button.
- **`reset_returns: false`** — your restart rebuilds state but forgets to reset the
  player/camera position, or `reset()` throws in the 'won'/'lost' phase.
- **Works locally, fails in the probe** — almost always an absolute path or an external
  network request. Everything must be relative and offline.
- **Input probe passes but controls are wrong** — the probe only proves keys change
  state, not that directions are right. Left/right inversion relative to the
  camera is a near-universal bug the probe cannot see: trace the sign yourself from
  key → rotation → on-screen direction (A moves left).

Fix, re-run `test_game`, and only finish when the report is clean: loaded, no errors,
renders at both screenshots, input changes state, all six `__bench` methods present.

# Playing the game with play_game

`play_game` serves the workspace, loads the page (1280x720), and executes your scripted
actions in order. After **every** action it snapshots `window.__bench` (`getState` +
`getPlayerPosition`) and reports `state_changed` — so each step is a small experiment:
*do X, expect Y, check*. Actions (each object uses exactly one):

| Action | Example | Notes |
|---|---|---|
| `click` | `{"click": [640, 360]}` | Optional `"button": "right"` (context orders), `"ms": 800` to hold |
| `drag` | `{"drag": [200, 200, 500, 400]}` | Press → move → release: box select, sliders |
| `move_mouse` | `{"move_mouse": [900, 360]}` | After a click that engages pointer lock, the game receives the relative movement (mouse look) |
| `press` | `{"press": "w", "ms": 1000}` | Holds the key; no `ms` = tap. Array holds a chord: `{"press": ["w", "Space"], "ms": 500}` |
| `wait` | `{"wait": 2000}` | Let waves spawn, timers tick, projectiles land |
| `screenshot` | `{"screenshot": true}` | Capture here (max 8/call; attached as images if your model has image input) |
| `eval` | `{"eval": "window.__bench.getEntities().length"}` | Any page JavaScript, JSON-serialized result |

Key names are Playwright's: `"w"`, `"a"`, `"ArrowLeft"`, `"Space"`, `"Shift"`, `"1"`.
Limits per call: 40 actions, 60s of session time.

## Keep it bounded

Scripted playtesting proves cause and effect — did it load, render, wire up, does an
input change state. It **cannot** tell you how anything feels: control, timing,
responsiveness are not observable here. Confirm each mechanic changes state once or
twice, then stop; don't loop `play_game` chasing feel. If a mechanic works but seems
off, read the code — don't re-play it. Spend the saved time building and polishing.

## Verify mechanics, not vibes

Test each **required mechanic from the brief** as a hypothesis with an observable
consequence. For example:

```json
{"actions": [
  {"click": [640, 360]},
  {"press": "w", "ms": 1000},
  {"eval": "window.__bench.getPlayerPosition()"},
  {"press": "Space"},
  {"wait": 500},
  {"eval": "window.__bench.getState()"},
  {"screenshot": true}
]}
```

- Movement: hold `w` for 1s → `player_pos` should change by roughly speed x time — not
  0 (input broken), not 500 units (no delta-time).
- Primary action: `Space` or a click → some counter, flag, or entity in `getState()` /
  `getEntities()` should change.
- Selection/targeting: if the game uses pointer selection, `drag` then right-`click`
  a target → the selected entity's position or state should update.
- Hazards/boundaries: walk into a hazard or wall and confirm the state reflects it.
- Win/lose reachability: confirm each end state can be *entered*, not that you can win
  by skill. For realtime games you usually can't play well enough to reach them —
  force the state instead (`eval` the win/lose condition, warp the player, advance
  progress near completion, set a timer near zero) and check the game responds
  correctly, then `reset`.

`state_changed: false` after an input is the single most important signal — the game
swallowed the action. And remember what a snapshot cannot tell you: *direction*.
Holding `d` changing the position proves input works, not that the player went right
relative to the camera — check a screenshot or compare positions across steps for that.

A good final pass exercises the win and lose states at least once each — but don't gate
"done" on beating the game by hand. If skillful realtime play is the only honest path,
force each end state (`eval`, warp, spawn) and confirm the game handles it, rather than
grinding for a clean run you may never get.
