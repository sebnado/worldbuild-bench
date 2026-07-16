import { ProbeReport, probeGame } from "./probes.js";
import { serveDir } from "./serve.js";

/**
 * Playability Score (0-100): weighted objective checklist computed from the
 * headless-browser probe. World Coherence Score (0-100): scripted probes
 * over the window.__bench telemetry contract.
 *
 * Weights are versioned in docs/methodology.md. If window.__bench is absent,
 * Playability is capped at NO_BENCH_CAP (documented ceiling) and World
 * Coherence is 0.
 */

export interface GateItem {
  id: string;
  weight: number;
  pass: boolean;
  detail: string;
}

export interface GateResult {
  playability: number;
  worldCoherence: number;
  benchPresent: boolean;
  capped: boolean;
  gates: GateItem[];
  coherenceGates: GateItem[];
  probe: ProbeReport;
}

export const NO_BENCH_CAP = 60;

export function scoreProbe(probe: ProbeReport): GateResult {
  const benchPresent =
    probe.bench.present && Object.values(probe.bench.methods).every(Boolean);

  const inputResponded =
    probe.input.benchStateChanged === true ||
    probe.input.playerMoved === true ||
    (probe.input.benchStateChanged === null && probe.input.screenshotChanged);

  const gates: GateItem[] = [
    {
      id: "loads",
      weight: 10,
      pass: probe.loadOk,
      detail: probe.loadOk ? "page load event fired" : `load failed: ${probe.loadError}`,
    },
    {
      id: "no_fatal_errors",
      weight: 10,
      pass: probe.loadOk && probe.pageErrors.length === 0 && probe.consoleErrors.length === 0,
      detail: `${probe.pageErrors.length} page errors, ${probe.consoleErrors.length} console errors`,
    },
    {
      id: "webgl_canvas",
      weight: 15,
      pass: probe.canvasCount > 0 && probe.canvasHasGlContext,
      detail: `${probe.canvasCount} canvas element(s), webgl context: ${probe.canvasHasGlContext}`,
    },
    {
      id: "renders",
      weight: 15,
      pass: probe.rendered2s || probe.rendered10s,
      detail: `visibly renders at 2s: ${probe.rendered2s}, at 10s: ${probe.rendered10s}`,
    },
    {
      id: "input_response",
      weight: 15,
      pass: inputResponded,
      detail: `bench state changed: ${probe.input.benchStateChanged}, player moved: ${probe.input.playerMoved}, screenshot changed: ${probe.input.screenshotChanged}`,
    },
    {
      id: "stable_fps",
      weight: 10,
      pass: (probe.fps?.avgFps ?? 0) >= 25,
      detail: probe.fps
        ? `avg fps ${probe.fps.avgFps.toFixed(1)} over ${probe.fps.sampleMs}ms (threshold 25)`
        : `fps sample failed${probe.fpsError ? `: ${probe.fpsError}` : ""} (threshold 25)`,
    },
    {
      id: "restart_works",
      weight: 10,
      pass: probe.coherence.resetReturns === true,
      detail: `__bench.reset() returns to initial state: ${probe.coherence.resetReturns}`,
    },
    {
      id: "bench_contract",
      weight: 15,
      pass: benchPresent,
      detail: probe.bench.present
        ? `methods: ${JSON.stringify(probe.bench.methods)}`
        : "window.__bench missing",
    },
  ];

  let playability = gates.reduce((s, g) => s + (g.pass ? g.weight : 0), 0);
  const capped = !benchPresent && playability > NO_BENCH_CAP;
  if (capped) playability = NO_BENCH_CAP;

  const coherenceGates: GateItem[] = [
    {
      id: "position_sane",
      weight: 25,
      pass: probe.coherence.positionSane === true,
      detail: `finite player position, no infinite fall (samples: ${probe.coherence.positionSamples.length})`,
    },
    {
      id: "camera_sane",
      weight: 20,
      pass: probe.coherence.cameraSane === true,
      detail: "camera info finite and within range of the player",
    },
    {
      id: "entities_query",
      weight: 20,
      pass: probe.coherence.entitiesQueryOk === true,
      detail: "getEntities() returns an array with finite positions",
    },
    {
      id: "state_evolves",
      weight: 20,
      pass: probe.coherence.stateEvolves === true,
      detail: "game state changes over the observation window",
    },
    {
      id: "reset_returns",
      weight: 15,
      pass: probe.coherence.resetReturns === true,
      detail: "reset() restores the initial state",
    },
  ];
  const worldCoherence = benchPresent || probe.bench.present
    ? coherenceGates.reduce((s, g) => s + (g.pass ? g.weight : 0), 0)
    : 0;

  return {
    playability,
    worldCoherence,
    benchPresent,
    capped,
    gates,
    coherenceGates,
    probe,
  };
}

/** Serve a workspace, probe it, and score it. */
export async function runGates(
  workspace: string,
  opts: { screenshotDir?: string; page?: string } = {},
): Promise<GateResult> {
  const server = await serveDir(workspace);
  try {
    const page = (opts.page ?? "index.html").replace(/^\/+/, "");
    const probe = await probeGame(`${server.url}/${page}`, {
      screenshotDir: opts.screenshotDir,
    });
    return scoreProbe(probe);
  } finally {
    await server.close();
  }
}
