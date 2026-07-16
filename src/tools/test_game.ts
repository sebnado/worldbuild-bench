import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Tool, ToolContext, ToolImage, ToolOutput } from "./index.js";
import { serveDir } from "../bench/serve.js";
import { probeGame, ProbeReport } from "../bench/probes.js";

/**
 * Serve the workspace on an ephemeral port and run the headless-browser
 * probe. Returns a structured JSON report the model can read: console and
 * page errors, canvas/WebGL status, render heuristics from screenshots,
 * FPS sample, input-probe outcome, and the window.__bench contract status.
 * For vision models the playtest screenshots follow the report as images.
 */
export const testGameTool: Tool = {
  def: {
    name: "test_game",
    description:
      "Serve the workspace and playtest it in a headless browser (~15s). Returns a JSON report: load status, console/page errors, canvas+WebGL check, whether the scene visibly renders at 2s and 10s, FPS sample, whether keyboard input changes game state, and the window.__bench telemetry contract status. If your model accepts image input, the playtest screenshots (at ~2s, right after the input probe, and at ~10s) follow the report — inspect them for visual defects the JSON cannot capture (blank or black screens, missing geometry, broken HUD/layout, camera problems). Use it early and after every significant change.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Workspace-relative HTML page to load (default index.html)",
        },
      },
    },
  },
  schema: z.object({ page: z.string().optional() }),

  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const server = await serveDir(ctx.workspace);
    const screenshotDir = path.join(ctx.workspace, ".playtest");
    try {
      const pagePath = (input.page ?? "index.html").replace(/^\/+/, "");
      const report = await probeGame(`${server.url}/${pagePath}`, { screenshotDir });
      return {
        text: formatReportForModel(report),
        images: collectScreenshots(screenshotDir),
      };
    } finally {
      await server.close();
    }
  },
};

/**
 * The probe's model-facing JPEG screenshots, in chronological order. Only
 * shown to models the registry marks vision: true — the agent drops images
 * for text-only models, whose report is unchanged.
 */
function collectScreenshots(dir: string): ToolImage[] {
  const shots: Array<{ file: string; label: string }> = [
    { file: "screenshot-2s.jpg", label: "Playtest screenshot ~2s after load:" },
    {
      file: "screenshot-post-input.jpg",
      label: "Playtest screenshot right after the input probe (click + WASD/arrows/space):",
    },
    { file: "screenshot-10s.jpg", label: "Playtest screenshot ~10s after load:" },
  ];
  const images: ToolImage[] = [];
  for (const s of shots) {
    const p = path.join(dir, s.file);
    if (!fs.existsSync(p)) continue;
    images.push({
      media_type: "image/jpeg",
      data: fs.readFileSync(p).toString("base64"),
      label: s.label,
    });
  }
  return images;
}

export function formatReportForModel(r: ProbeReport): string {
  const model = {
    loaded: r.loadOk,
    load_error: r.loadError,
    console_errors: r.consoleErrors.slice(0, 20),
    page_errors: r.pageErrors.slice(0, 20),
    canvas: {
      count: r.canvasCount,
      has_webgl_context: r.canvasHasGlContext,
      webgl_available_in_browser: r.webglAvailable,
    },
    rendering: {
      visibly_renders_at_2s: r.rendered2s,
      visibly_renders_at_10s: r.rendered10s,
      note: "render check = screenshot luminance variance + distinct colors; a black or blank screen fails",
      screenshot_2s: r.screenshot2s,
      screenshot_10s: r.screenshot10s,
    },
    fps: r.fps,
    ...(r.fpsError ? { fps_error: r.fpsError } : {}),
    input_probe: {
      keys_dispatched: r.input.dispatched,
      bench_state_changed: r.input.benchStateChanged,
      player_moved: r.input.playerMoved,
      screenshot_changed: r.input.screenshotChanged,
    },
    bench_contract: r.bench,
    coherence_probes: r.coherence,
    probe_duration_ms: r.durationMs,
  };
  return JSON.stringify(model, null, 2);
}
