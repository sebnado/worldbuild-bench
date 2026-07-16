# WorldBuild Bench — Methodology

**Version 1.0 — July 2026.** This document is versioned; scoring changes bump the
version and are listed in the changelog. The citable, always-current copy lives at
[sandscape.app/worldbuild/methodology](https://sandscape.app/worldbuild/methodology).

## What is measured

Each benchmarked model receives an identical agentic harness (this repository) and a
task brief describing a 3D browser game. The model plans, writes, playtests, and ships a
game that must run from static files with the bundled libraries (Three.js, optional
Rapier physics). Scores measure the
result along four axes:

| Score | Kind | Source |
|---|---|---|
| Playability Score (0–100) | objective | headless-browser gates (this repo) |
| World Coherence Score (0–100) | objective | scripted `window.__bench` probes (this repo) |
| Arena Rating | human preference | pairwise public votes (site) |
| WorldBuild Efficiency | cost-adjusted | rating per dollar (site) |

The headline **WorldBuild Rating** combines them (weights below).

## Neutrality measures

- Identical system prompt, tools, skills, scaffold, and budget backstops for every
  model; the prompt contains no provider- or model-specific phrasing.
- **Task briefs pin the game concept.** Each brief fixes the game's name, setting,
  aesthetic direction, feel, and core loop (alongside the required mechanics), so every
  model executes the same design and differences between runs measure execution rather
  than concept luck — and arena votes compare two realizations of the same vision.
  Interpretation, art execution, and polish remain entirely the model's. Briefs are
  versioned in this repository; no brief prescribes technical approach (engine
  techniques, algorithms, or file structure stay the model's choice).
- Direct HTTP adapters (no provider SDKs). Direct OpenAI is served via the Responses
  API (current OpenAI reasoning models reject function tools + reasoning effort on
  Chat Completions); any OpenAI-compatible endpoint (OpenRouter, Groq, Cerebras) is
  served by the same Chat Completions adapter code path. Both paths are stateless:
  the full conversation is replayed each call (OpenAI Responses runs with
  `store: false`, reasoning items replayed as encrypted content).
- **Sampling: provider defaults.** No temperature/top-p is sent to any provider —
  several current reasoning APIs reject non-default sampling parameters, and a fixed
  temperature is not comparable across different samplers anyway. Every model runs on
  its provider's default sampler.
- **Reasoning: enabled by default, per provider.** Models that reason by default
  (OpenAI and Gemini reasoning models) run with their defaults; Anthropic models that
  support adaptive thinking run with `thinking: adaptive` (flagged per model in
  `models.json`) so every provider's models reason by default under the same
  conditions. Models without such a mode run on their provider default. Reasoning
  tokens count toward the per-turn max-tokens cap wherever the provider counts them as
  output, and are billed as output tokens in the cost accounting.
  A round may additionally pin a **requested effort tier** (low / medium / high /
  xhigh) — the same tier for every model, sent via each provider's native control:
  OpenAI Responses `reasoning.effort`, OpenRouter's unified `reasoning.effort` (mapped by
  OpenRouter to each routed model's nearest supported level), Anthropic
  `output_config.effort`, Gemini `thinkingConfig.thinkingLevel` (no xhigh; clamps
  to HIGH). Unset — the default — means provider default. The tier actually
  requested is recorded per run in `result.json` (`model.reasoning_effort`).
- **Visual feedback: vision models see their playtest screenshots.** `test_game`
  attaches its playtest screenshots (~2s after load, right after the input probe,
  ~10s; JPEG) — and `play_game` the captures requested by its screenshot actions — to
  the tool result for models that accept image input — like context
  length or output length, vision is a property of the model being benchmarked, and
  withholding images from every model would blind the sighted to protect the blind.
  Text-only models receive the identical JSON report with no images. The capability
  is flagged per model in `models.json` (`vision`, verified against provider docs and
  the OpenRouter models API `input_modalities`, dated in its `$comment`), and every
  run records whether it had visual feedback (`model.vision`) and how many images the
  model was shown (`agent.images_sent`) in `result.json`, so sighted and blind runs
  are always distinguishable when comparing results.
- **Per-turn output cap: the model's own maximum, within transport limits.** Like
  context length, maximum output length is a property of the model being
  benchmarked — capping every model to the smallest common value would artificially
  truncate long-output and reasoning-heavy models. Each model runs at
  min(its documented max completion tokens, a 32768 practical ceiling set by the
  harness's non-streaming 600s per-attempt window; 16384 on the Anthropic adapter,
  whose API requires streaming for longer requests). Values live in `models.json`
  (`max_output_tokens`, verified against provider/OpenRouter listings and dated in
  its `$comment`); the cap actually used is recorded per call in the transcript.
  When a reply is cut off at the cap, the model is told so explicitly (and can
  build large files across calls with `write_file` append), so no model silently
  loses work to truncation.
- **Prompt caching: every provider's native mechanism, billed at cached rates.**
  OpenAI and Gemini cache prompts implicitly; the Anthropic adapter opts in with
  the standard ephemeral `cache_control` breakpoints (system prompt + last
  message) so no provider re-bills its full prompt every turn. Cost accounting
  bills cached reads/writes at each provider's published cached rates
  (`models.json`), and cached token counts are recorded per call in the
  transcript and as `tokens_in_cached` in `result.json`.
- **Finish confirmation.** A reply containing no tool calls ends an agent only when
  it is the second in a row: the first draws one fixed confirmation nudge (identical
  for every model, recorded in the transcript). Some models narrate an intended
  action ("Let me now test the game.") and stop without issuing the tool call —
  without the nudge, that stop quirk ends a run with the game unfinished and
  scores would measure tool-call discipline rather than the game built.
- Transient provider errors (408/429/5xx/529, network timeouts) are retried with
  exponential backoff and jitter (honoring `retry-after`, up to 5 attempts) so models
  on busier providers are not penalized by one-off rate limits. If a run still aborts,
  the partial turn/token/cost accounting up to the failure is recorded in
  `result.json` together with the error.
- Every run keeps a full JSONL transcript (requests, responses, tool calls, results,
  usage, costs) so results can be audited and reproduced.
- The tool actually used is recorded in results — there are no silent fallbacks. The
  model id each provider reports it actually served is recorded per run
  (`served_model_ids` in `result.json`) and any divergence from the requested model is
  flagged.

## Budgets: natural completion, backstops only

Runs end at the **model's natural completion** — the model decides when the game is
done (see finish confirmation above). No limit is a design constraint on the game:
every cap is a pathology backstop set far above honest work, and a run that trips
one is flagged in `result.json` (`budget_exhausted`), never silently truncated.
Cost is recorded per run and displayed alongside scores, but it is **scored only in
the Efficiency track** — the quality tracks measure the model's best work regardless
of what it cost. (A fixed dollar cap would not even be neutral: the same dollars buy
vastly different token counts across providers.)

Default backstops per run: **$100 USD / 6 hours wall-clock / 10,000 turns**; tokens
are effectively unlimited (cost already prices them; a token cap remains available
as a debug knob). All configurable per round; a round publishes the backstops it
used. The cost backstop is enforced by **per-call reservations**: before every
provider call the harness reserves the call's worst case (estimated input cost + the
call's max output tokens at list price), clamping the per-call max output tokens
down when the remainder is tight, and settles the reservation with the actual cost
from the response. On exhaustion the model gets one final turn (tool calls
forbidden) to wrap up — that call reserves too. Backstops are **shared across the
whole agent tree**: every agent draws on the run's single tracker through the same
reservation guard, so spawning many concurrent subagents cannot multiply them.
The per-attempt provider timeout is capped to
the remaining wall-clock, and no call is issued with under ~5s of wall left. Cost is computed from the per-model pricing table in `models.json` —
cache-aware: cached prompt reads and writes are billed at the provider's cached
rates, not list price — except where the provider returns an exact cost
(OpenRouter), which takes precedence.

## Playability Score (0–100)

A weighted objective checklist computed by `wb gate` from an automated ~15-second
headless-chromium session (`src/bench/gates.ts`):

| Gate | Weight | Passes when |
|---|---|---|
| `loads` | 10 | the page load event fires |
| `no_fatal_errors` | 10 | zero uncaught page errors and zero console errors |
| `webgl_canvas` | 15 | a canvas exists and holds a WebGL/WebGL2 context |
| `renders` | 15 | a screenshot at 2s or 10s is visibly non-blank (luminance variance + distinct-color heuristics) |
| `input_response` | 15 | the keyboard probe (click, then W/ArrowUp/A/D/Space) changes `__bench` state, moves the player, or (absent `__bench`) changes the framebuffer |
| `stable_fps` | 10 | mean requestAnimationFrame rate over ~2s ≥ 25 fps |
| `restart_works` | 10 | `__bench.reset()` restores the initial state/position |
| `bench_contract` | 15 | all six `window.__bench` methods are present |

**No-telemetry cap:** if the `window.__bench` contract is missing or incomplete, the
Playability Score is capped at **60** and World Coherence is 0. The contract is stated
in every task brief and in a dedicated skill, so implementing it is part of the task.

## World Coherence Score (0–100)

Scripted probes over the required telemetry contract:

```js
window.__bench = {
  getState(),            // JSON-serializable game state snapshot
  reset(),               // restart to the initial state
  getPlayerPosition(),   // {x, y, z} finite numbers, world space
  getCameraInfo(),       // { position, direction, fov }
  getEntities(),         // [{ id, kind, position }]
  getObjectiveStatus(),  // { objective, progress, won, lost }
}
```

| Probe | Weight | Passes when |
|---|---|---|
| `position_sane` | 25 | every sampled player position is finite; no infinite fall (y > −100), no runaway coordinates |
| `camera_sane` | 20 | camera info is finite and the camera stays within range of the player |
| `entities_query` | 20 | `getEntities()` returns an array whose entries have finite positions |
| `state_evolves` | 20 | game state (or player position) changes over the observation window |
| `reset_returns` | 15 | after `reset()`, position/state match the initial values |

V1 probes are deliberately simple; the probe set expands in future rounds (announced in
this document with a version bump).

## Arena Rating (human preference)

Computed from public pairwise votes at sandscape.app/worldbuild/arena, not by this repo.

- Voters play two games built for the same task by hidden models, side-randomized, and
  answer: **"Which game would you rather keep playing?"** — options A / B / Tie /
  Both bad, with optional reason chips after the vote.
- Only votes where both sides were played ≥ 20 seconds count toward the rating; others
  are logged but excluded. Votes are IP rate-limited and deduplicated by a salted
  voter hash. Model identities are revealed only after voting.
- Ratings are fit with a **Bradley-Terry** model (ties as half-wins; "both bad"
  excluded), displayed on an Elo-like scale (anchor 1000, scale 400/ln 10) with 95%
  bootstrap confidence intervals. A model's rating is **provisional** until it has
  ≥ 50 counted votes.

## WorldBuild Efficiency

Cost-adjusted track: preference-or-playability per dollar of run cost. Displayed as its
own toggle/track and never silently folded into the headline score.

## WorldBuild Rating (headline)

```
WorldBuild Rating = 0.55 · ArenaRating_norm
                  + 0.25 · Playability
                  + 0.15 · WorldCoherence
                  + 0.05 · Efficiency_norm
```

Weights are versioned here. Honesty rule: the composite is shown **only when the arena
component has enough votes**; otherwise the leaderboard shows the sub-scores with an
"awaiting arena votes" state. A flattened score built from missing components is never
displayed.

## Rounds, tracks, and results

A round = one harness version × a set of tasks (tracks) × a set of models, all run with
the same budgets. Per run, `result.json` records: model, task, budgets, wall-clock,
tokens in/out, cost, turns, tool-call counts, subagents spawned, code lines/files, the
full gate detail, both scores, and screenshots. `wb report` merges runs into the round
JSON (schema v2) published on the site as open data.

The April 2026 round predates this harness (it ran on an internal pipeline) and is
archived as a **legacy round**: original metrics only, marked not comparable, excluded
from the WorldBuild Rating leaderboard.

## Changelog

- **v1.2 (2026-07-05)** — process tools, identical for every model: `update_tasks`
  (a per-agent task list — each call replaces the whole list; private to each
  agent, recorded in the transcript) and `play_game` (a model-scripted interactive
  playtest: click / drag / move_mouse / press-and-hold / wait / eval / screenshot
  actions, with a `window.__bench` state snapshot and `state_changed` flag after
  every action, capped at 40 actions / 60s / 8 screenshots per call). `play_game`
  screenshots follow the v1.1 visual-feedback rule and count in
  `agent.images_sent`. `test_game` and the scoring gates are unchanged.
- **v1.1 (2026-07-05)** — visual feedback: `test_game` attaches its playtest
  screenshots to the tool result for vision models (`vision` flag in `models.json`);
  text-only models get the unchanged JSON report. Recorded per run as `model.vision`
  and `agent.images_sent`. Scoring gates unchanged.
- **v1.0 (2026-07)** — initial public methodology: gate weights above, no-telemetry cap
  60, coherence probe set v1, Bradley-Terry arena with 20s minimum play and 50-vote
  provisional threshold, composite weights 0.55 / 0.25 / 0.15 / 0.05.
