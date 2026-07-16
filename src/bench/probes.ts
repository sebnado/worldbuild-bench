import fs from "node:fs";
import path from "node:path";
import { chromium, Browser, Page } from "playwright";
import { PngStats, pngStats, looksRendered } from "../util/png.js";

/**
 * Headless-browser probe shared by the test_game tool and the scoring gates.
 * Loads a served game, captures console/page errors, checks canvas + WebGL,
 * screenshots at ~2s and ~10s, dispatches a keyboard input probe, samples
 * FPS, and exercises the window.__bench telemetry contract when present.
 */

export const BENCH_METHODS = [
  "getState",
  "reset",
  "getPlayerPosition",
  "getCameraInfo",
  "getEntities",
  "getObjectiveStatus",
] as const;

export interface BenchCallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface ProbeReport {
  url: string;
  loadOk: boolean;
  loadError: string | null;
  consoleErrors: string[];
  pageErrors: string[];
  canvasCount: number;
  canvasHasGlContext: boolean;
  webglAvailable: boolean;
  screenshot2s: PngStats | null;
  screenshot10s: PngStats | null;
  rendered2s: boolean;
  rendered10s: boolean;
  fps: { avgFps: number; frames: number; sampleMs: number } | null;
  /** Why fps is null (probe failure), so a broken sampler is never silent. */
  fpsError?: string;
  input: {
    dispatched: string[];
    benchStateChanged: boolean | null;
    playerMoved: boolean | null;
    screenshotChanged: boolean;
  };
  bench: {
    present: boolean;
    methods: Record<string, boolean>;
    calls: Record<string, BenchCallResult>;
  };
  coherence: {
    positionSamples: Array<{ t: number; pos: unknown }>;
    positionSane: boolean | null;
    cameraSane: boolean | null;
    entitiesQueryOk: boolean | null;
    stateEvolves: boolean | null;
    resetReturns: boolean | null;
  };
  durationMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isFiniteNum(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

function posOf(v: unknown): { x: number; y: number; z: number } | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (isFiniteNum(o.x) && isFiniteNum(o.y) && isFiniteNum(o.z)) {
      return { x: o.x as number, y: o.y as number, z: o.z as number };
    }
  }
  if (Array.isArray(v) && v.length >= 3 && v.every(isFiniteNum)) {
    return { x: v[0], y: v[1], z: v[2] };
  }
  return null;
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

async function benchSnapshot(page: Page): Promise<ProbeReport["bench"]> {
  return page.evaluate((methodNames) => {
    const w = window as any;
    const b = w.__bench;
    const methods: Record<string, boolean> = {};
    const calls: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
    if (!b || typeof b !== "object") return { present: false, methods, calls };
    for (const m of methodNames) methods[m] = typeof b[m] === "function";
    for (const m of methodNames) {
      if (m === "reset" || !methods[m]) continue; // reset is exercised separately
      try {
        let v = b[m]();
        try {
          v = JSON.parse(JSON.stringify(v ?? null));
        } catch {
          v = String(v);
        }
        calls[m] = { ok: true, value: v };
      } catch (e) {
        calls[m] = { ok: false, error: String(e) };
      }
    }
    return { present: true, methods, calls };
  }, BENCH_METHODS as unknown as string[]);
}

async function callBench(page: Page, method: string): Promise<BenchCallResult> {
  return page.evaluate((m) => {
    const b = (window as any).__bench;
    if (!b || typeof b[m] !== "function") return { ok: false, error: `__bench.${m} missing` };
    try {
      let v = b[m]();
      try {
        v = JSON.parse(JSON.stringify(v ?? null));
      } catch {
        v = String(v);
      }
      return { ok: true, value: v };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, method);
}

export interface ProbeOptions {
  /** Directory to write screenshot-2s.png / screenshot-10s.png into. */
  screenshotDir?: string;
  /** Total observation cap; the probe itself targets ~15-20s. */
  timeoutMs?: number;
}

export async function probeGame(url: string, opts: ProbeOptions = {}): Promise<ProbeReport> {
  const started = Date.now();
  const report: ProbeReport = {
    url,
    loadOk: false,
    loadError: null,
    consoleErrors: [],
    pageErrors: [],
    canvasCount: 0,
    canvasHasGlContext: false,
    webglAvailable: false,
    screenshot2s: null,
    screenshot10s: null,
    rendered2s: false,
    rendered10s: false,
    fps: null,
    input: { dispatched: [], benchStateChanged: null, playerMoved: null, screenshotChanged: false },
    bench: { present: false, methods: {}, calls: {} },
    coherence: {
      positionSamples: [],
      positionSane: null,
      cameraSane: null,
      entitiesQueryOk: null,
      stateEvolves: null,
      resetReturns: null,
    },
    durationMs: 0,
  };

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", (msg) => {
      if (msg.type() === "error") report.consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on("pageerror", (err) => report.pageErrors.push(String(err).slice(0, 500)));

    try {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      report.loadOk = true;
    } catch (e: any) {
      report.loadError = e?.message ?? String(e);
      report.durationMs = Date.now() - started;
      return report;
    }

    await sleep(2000);

    // Screenshot @2s. PNG feeds the render-stats heuristics; the JPEG twin
    // (q60, ~5-10x smaller) is what test_game attaches for vision models.
    const shot2 = await page.screenshot({ type: "png" });
    if (opts.screenshotDir) {
      fs.mkdirSync(opts.screenshotDir, { recursive: true });
      fs.writeFileSync(path.join(opts.screenshotDir, "screenshot-2s.png"), shot2);
      fs.writeFileSync(
        path.join(opts.screenshotDir, "screenshot-2s.jpg"),
        await page.screenshot({ type: "jpeg", quality: 60 }),
      );
    }
    try {
      report.screenshot2s = pngStats(shot2);
      report.rendered2s = looksRendered(report.screenshot2s);
    } catch {
      /* stats stay null */
    }

    // Canvas + WebGL
    const gl = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll("canvas"));
      let hasGl = false;
      for (const c of canvases) {
        for (const t of ["webgl2", "webgl", "experimental-webgl"]) {
          try {
            if (c.getContext(t as any)) {
              hasGl = true;
              break;
            }
          } catch {
            /* a canvas with a different context type throws/returns null */
          }
        }
        if (hasGl) break;
      }
      let available = false;
      try {
        const test = document.createElement("canvas");
        available = !!(test.getContext("webgl2") || test.getContext("webgl"));
      } catch {
        available = false;
      }
      return { count: canvases.length, hasGl, available };
    });
    report.canvasCount = gl.count;
    report.canvasHasGlContext = gl.hasGl;
    report.webglAvailable = gl.available;

    // __bench contract snapshot + initial references
    report.bench = await benchSnapshot(page);
    const initialState = report.bench.calls.getState?.ok
      ? JSON.stringify(report.bench.calls.getState.value)
      : null;
    const initialPos = posOf(report.bench.calls.getPlayerPosition?.value);

    // Input probe: click the scene (many games need focus/start), then keys.
    try {
      await page.mouse.click(640, 360);
      await sleep(300);
    } catch {
      /* non-fatal */
    }
    const preInputShot = await page.screenshot({ type: "png" });
    const preInputPos = report.bench.present
      ? posOf((await callBench(page, "getPlayerPosition")).value)
      : null;
    const preInputState = report.bench.present
      ? JSON.stringify((await callBench(page, "getState")).value ?? null)
      : null;

    for (const key of ["w", "ArrowUp", "a", "d"]) {
      try {
        await page.keyboard.down(key);
        await sleep(250);
        await page.keyboard.up(key);
        report.input.dispatched.push(key);
      } catch {
        /* keep going */
      }
    }
    try {
      await page.keyboard.press(" ");
      report.input.dispatched.push("Space");
    } catch {
      /* ignore */
    }
    await sleep(300);

    const postInputShot = await page.screenshot({ type: "png" });
    if (opts.screenshotDir) {
      fs.writeFileSync(path.join(opts.screenshotDir, "screenshot-post-input.png"), postInputShot);
      fs.writeFileSync(
        path.join(opts.screenshotDir, "screenshot-post-input.jpg"),
        await page.screenshot({ type: "jpeg", quality: 60 }),
      );
    }
    try {
      const a = pngStats(preInputShot);
      const b = pngStats(postInputShot);
      report.input.screenshotChanged =
        Math.abs(a.meanLuma - b.meanLuma) > 1 ||
        Math.abs(a.stdLuma - b.stdLuma) > 1 ||
        Math.abs(a.distinctColors - b.distinctColors) > 4;
    } catch {
      report.input.screenshotChanged = !preInputShot.equals(postInputShot);
    }
    if (report.bench.present) {
      const postPos = posOf((await callBench(page, "getPlayerPosition")).value);
      const postState = JSON.stringify((await callBench(page, "getState")).value ?? null);
      report.input.playerMoved =
        preInputPos && postPos ? dist(preInputPos, postPos) > 0.05 : null;
      report.input.benchStateChanged =
        preInputState !== null ? preInputState !== postState : null;
    }

    // FPS sample (~2s of requestAnimationFrame). A string expression, not a
    // closure: esbuild (tsx) wraps named inner bindings like `tick` in a
    // __name() helper that doesn't exist once the function is serialized
    // into the page, throwing ReferenceError on every call.
    try {
      const fps = (await page.evaluate(`new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = (now) => {
          frames++;
          if (now - start >= 2000) resolve({ frames, ms: now - start });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve({ frames, ms: performance.now() - start }), 3500);
      })`)) as { frames: number; ms: number };
      report.fps = {
        avgFps: fps.ms > 0 ? (fps.frames / fps.ms) * 1000 : 0,
        frames: fps.frames,
        sampleMs: Math.round(fps.ms),
      };
    } catch (e: any) {
      report.fps = null;
      report.fpsError = (e?.message ?? String(e)).slice(0, 300);
    }

    // Coherence sampling while time passes toward the 10s mark.
    if (report.bench.present) {
      for (let i = 0; i < 5; i++) {
        const r = await callBench(page, "getPlayerPosition");
        report.coherence.positionSamples.push({
          t: Date.now() - started,
          pos: r.ok ? r.value : `error: ${r.error}`,
        });
        await sleep(500);
      }
      const positions = report.coherence.positionSamples
        .map((s) => posOf(s.pos))
        .filter((p): p is NonNullable<ReturnType<typeof posOf>> => p !== null);
      report.coherence.positionSane =
        positions.length === report.coherence.positionSamples.length &&
        positions.every((p) => p.y > -100 && Math.abs(p.x) < 100_000 && Math.abs(p.z) < 100_000);

      const cam = await callBench(page, "getCameraInfo");
      const camObj = (cam.value ?? {}) as Record<string, unknown>;
      const camPos = posOf(camObj.position ?? cam.value);
      const lastPos = positions[positions.length - 1] ?? null;
      report.coherence.cameraSane =
        cam.ok && camPos !== null && (lastPos === null || dist(camPos, lastPos) < 500);

      const ents = await callBench(page, "getEntities");
      report.coherence.entitiesQueryOk =
        ents.ok &&
        Array.isArray(ents.value) &&
        (ents.value as unknown[]).every((e) => {
          const p = posOf((e as Record<string, unknown>)?.position ?? e);
          return p === null || (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
        });
    }

    // Wait until ~10s after load for the second screenshot.
    const elapsed = Date.now() - started;
    if (elapsed < 10_000) await sleep(10_000 - elapsed);
    const shot10 = await page.screenshot({ type: "png" });
    if (opts.screenshotDir) {
      fs.writeFileSync(path.join(opts.screenshotDir, "screenshot-10s.png"), shot10);
      fs.writeFileSync(
        path.join(opts.screenshotDir, "screenshot-10s.jpg"),
        await page.screenshot({ type: "jpeg", quality: 60 }),
      );
    }
    try {
      report.screenshot10s = pngStats(shot10);
      report.rendered10s = looksRendered(report.screenshot10s);
    } catch {
      /* stats stay null */
    }

    if (report.bench.present) {
      // State evolution over the whole observation window.
      const lateState = await callBench(page, "getState");
      const lateJson = JSON.stringify(lateState.value ?? null);
      const positions = report.coherence.positionSamples
        .map((s) => posOf(s.pos))
        .filter((p): p is NonNullable<ReturnType<typeof posOf>> => p !== null);
      const moved =
        positions.length >= 2 && dist(positions[0], positions[positions.length - 1]) > 0.01;
      report.coherence.stateEvolves =
        (initialState !== null && lateState.ok && lateJson !== initialState) || moved;

      // Reset probe: state/position should return near the initial values.
      const reset = await callBench(page, "reset");
      if (reset.ok) {
        await sleep(600);
        const afterPos = posOf((await callBench(page, "getPlayerPosition")).value);
        const afterState = JSON.stringify((await callBench(page, "getState")).value ?? null);
        if (initialPos && afterPos) {
          report.coherence.resetReturns = dist(initialPos, afterPos) < 5;
        } else if (initialState !== null) {
          report.coherence.resetReturns = afterState === initialState;
        } else {
          report.coherence.resetReturns = true; // reset() didn't throw; nothing to compare
        }
      } else {
        report.coherence.resetReturns = false;
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    report.durationMs = Date.now() - started;
  }
  return report;
}
