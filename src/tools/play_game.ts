import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chromium, Browser, Page } from "playwright";
import { Tool, ToolContext, ToolImage, ToolOutput, truncate } from "./index.js";
import { serveDir } from "../bench/serve.js";

/**
 * Interactive playtest: the model scripts a session (clicks, drags, key
 * holds, waits, evals, screenshots) and the harness executes it in a
 * headless browser, snapshotting window.__bench after every action with a
 * state_changed flag — action → observed effect, the causal loop the bench
 * is about. test_game stays the standardized health check the scoring gates
 * mirror; play_game is how the model verifies specific mechanics.
 */

const MAX_ACTIONS = 40;
const MAX_HOLD_MS = 10_000;
const MAX_SESSION_MS = 60_000;
const MAX_SCREENSHOTS = 8;
/** Small pause after each action so the game loop can react before the snapshot. */
const SETTLE_MS = 120;
const VIEWPORT = { width: 1280, height: 720 };

const buttonSchema = z.enum(["left", "right", "middle"]);
const actionSchema = z.union([
  z.object({
    click: z.tuple([z.number(), z.number()]),
    button: buttonSchema.optional(),
    ms: z.number().min(0).max(MAX_HOLD_MS).optional(),
  }),
  z.object({
    drag: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    button: buttonSchema.optional(),
  }),
  z.object({ move_mouse: z.tuple([z.number(), z.number()]) }),
  z.object({
    press: z.union([z.string().min(1).max(30), z.array(z.string().min(1).max(30)).min(1).max(4)]),
    ms: z.number().min(0).max(MAX_HOLD_MS).optional(),
  }),
  z.object({ wait: z.number().min(0).max(MAX_HOLD_MS) }),
  z.object({ screenshot: z.boolean() }),
  z.object({ eval: z.string().min(1).max(4000) }),
]);

type Action = z.infer<typeof actionSchema>;

export const playGameTool: Tool = {
  def: {
    name: "play_game",
    description:
      "Actually play the game: serve the workspace, load the page in a headless browser " +
      `(${VIEWPORT.width}x${VIEWPORT.height}), and execute your scripted actions in order. After every action the ` +
      "window.__bench state and player position are snapshotted and a state_changed flag reports " +
      "whether the action had an effect — use it to verify cause and effect (\"right-click orders a " +
      "harvester\", \"Space fires\", \"driving into a wall stops the car\"). Each action object uses " +
      "exactly one of: click (with optional button/ms hold), drag (press-move-release, e.g. box " +
      "select), move_mouse (pointer-locked games receive the relative movement), press (hold keys " +
      "for ms, or tap; Playwright key names like \"w\", \"ArrowLeft\", \"Space\"), wait, screenshot " +
      "(if your model accepts image input, the captures follow the report as images), eval " +
      "(JavaScript run in the page, JSON-serialized result). " +
      `Limits per call: ${MAX_ACTIONS} actions, ${MAX_SESSION_MS / 1000}s of session time, ${MAX_SCREENSHOTS} screenshots. ` +
      "Use test_game first for overall health; use play_game to test specific mechanics and gameplay sequences.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Workspace-relative HTML page to load (default index.html)",
        },
        actions: {
          type: "array",
          description:
            "Actions executed in order; each object uses exactly one of the action properties " +
            "(click / drag / move_mouse / press / wait / screenshot / eval).",
          items: {
            type: "object",
            properties: {
              click: {
                type: "array",
                items: { type: "number" },
                description:
                  "[x,y] viewport coords to click; add button: 'right' for context orders, ms to hold the button down",
              },
              drag: {
                type: "array",
                items: { type: "number" },
                description: "[x1,y1,x2,y2] press at start, move, release at end (box select, sliders)",
              },
              move_mouse: {
                type: "array",
                items: { type: "number" },
                description:
                  "[x,y] move the pointer; after a click that engages pointer lock, the game receives the relative movement (mouse look)",
              },
              press: {
                type: "string",
                description:
                  "Key to press — Playwright key names (\"w\", \"ArrowLeft\", \"Space\", \"Shift\"). " +
                  "With ms, the key is held down that long; an array of up to 4 keys holds them together (e.g. move while firing)",
              },
              ms: {
                type: "number",
                description: "Hold duration in milliseconds for press/click (max 10000)",
              },
              button: {
                type: "string",
                enum: ["left", "right", "middle"],
                description: "Mouse button for click/drag (default left)",
              },
              wait: { type: "number", description: "Do nothing for this many milliseconds (max 10000)" },
              screenshot: { type: "boolean", description: "Capture a screenshot at this point" },
              eval: {
                type: "string",
                description:
                  "JavaScript evaluated in the page (an expression, or a function like \"() => ...\"); the JSON-serialized value is returned",
              },
            },
          },
        },
      },
      required: ["actions"],
    },
  },
  schema: z.object({
    page: z.string().optional(),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  }),

  async execute(input, ctx: ToolContext): Promise<ToolOutput> {
    const started = Date.now();
    const server = await serveDir(ctx.workspace);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const images: ToolImage[] = [];
    const report: Record<string, unknown> = {
      loaded: false,
      load_error: null,
      bench_present: false,
      initial: null,
      steps: [] as unknown[],
      final: null,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      screenshots_taken: 0,
      duration_ms: 0,
    };
    const steps = report.steps as Record<string, unknown>[];

    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
      const page = await browser.newPage({ viewport: VIEWPORT });
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
      });
      page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

      const pagePath = (input.page ?? "index.html").replace(/^\/+/, "");
      try {
        await page.goto(`${server.url}/${pagePath}`, { waitUntil: "load", timeout: 30_000 });
        report.loaded = true;
      } catch (e: any) {
        report.load_error = e?.message ?? String(e);
        return finish();
      }
      await sleep(1500);

      let prev = await snapshotBench(page);
      report.bench_present = prev.present;
      report.initial = { state: prev.state, player_pos: prev.pos };

      const sessionStart = Date.now();
      for (let i = 0; i < input.actions.length; i++) {
        const action = input.actions[i] as Action;
        const entry: Record<string, unknown> = { step: i + 1, action };
        if (Date.now() - sessionStart > MAX_SESSION_MS) {
          entry.skipped = `session cap (${MAX_SESSION_MS / 1000}s) reached`;
          steps.push(entry);
          continue;
        }
        try {
          await performAction(page, action, entry, report, images, ctx.workspace, i + 1);
        } catch (e: any) {
          entry.error = (e?.message ?? String(e)).slice(0, 300);
        }
        if (!("wait" in action)) await sleep(SETTLE_MS);
        const cur = await snapshotBench(page);
        entry.state_changed = cur.stateJson !== prev.stateJson;
        entry.player_pos = cur.pos;
        entry.state = entry.state_changed ? cur.state : "(unchanged)";
        prev = cur;
        steps.push(entry);
      }
      report.final = { state: prev.state, player_pos: prev.pos };
    } finally {
      await browser?.close().catch(() => {});
      await server.close();
    }
    return finish();

    function finish(): ToolOutput {
      report.duration_ms = Date.now() - started;
      return {
        text: truncate(JSON.stringify(report, null, 2), 24_000, "play_game report"),
        images,
      };
    }
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clampX = (v: number) => Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(v)));
const clampY = (v: number) => Math.max(0, Math.min(VIEWPORT.height - 1, Math.round(v)));

async function performAction(
  page: Page,
  action: Action,
  entry: Record<string, unknown>,
  report: Record<string, unknown>,
  images: ToolImage[],
  workspace: string,
  stepNo: number,
): Promise<void> {
  if ("click" in action) {
    const [x, y] = action.click;
    const button = action.button ?? "left";
    if (action.ms && action.ms > 0) {
      await page.mouse.move(clampX(x), clampY(y));
      await page.mouse.down({ button });
      await sleep(action.ms);
      await page.mouse.up({ button });
    } else {
      await page.mouse.click(clampX(x), clampY(y), { button });
    }
  } else if ("drag" in action) {
    const [x1, y1, x2, y2] = action.drag;
    const button = action.button ?? "left";
    await page.mouse.move(clampX(x1), clampY(y1));
    await page.mouse.down({ button });
    await page.mouse.move(clampX(x2), clampY(y2), { steps: 12 });
    await sleep(80);
    await page.mouse.up({ button });
  } else if ("move_mouse" in action) {
    const [x, y] = action.move_mouse;
    await page.mouse.move(clampX(x), clampY(y), { steps: 8 });
  } else if ("press" in action) {
    const keys = Array.isArray(action.press) ? action.press : [action.press];
    const holdMs = action.ms ?? 0;
    if (holdMs > 0 || keys.length > 1) {
      for (const k of keys) await page.keyboard.down(k);
      await sleep(Math.max(holdMs, 50));
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
    } else {
      await page.keyboard.press(keys[0]);
    }
  } else if ("wait" in action) {
    await sleep(action.wait);
  } else if ("screenshot" in action) {
    if (!action.screenshot) return;
    if ((report.screenshots_taken as number) >= MAX_SCREENSHOTS) {
      entry.screenshot = `skipped: cap reached (${MAX_SCREENSHOTS}/call)`;
      return;
    }
    const buf = await page.screenshot({ type: "jpeg", quality: 60 });
    const dir = path.join(workspace, ".playtest");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `play-step-${stepNo}.jpg`), buf);
    images.push({
      media_type: "image/jpeg",
      data: buf.toString("base64"),
      label: `play_game screenshot after step ${stepNo}:`,
    });
    report.screenshots_taken = (report.screenshots_taken as number) + 1;
    entry.screenshot = "captured";
  } else if ("eval" in action) {
    // Raw string handed to Playwright: a function source is invoked, a bare
    // expression is evaluated — and string form bypasses the esbuild
    // transform that breaks serialized closures (see probes.ts FPS note).
    const value = await page.evaluate(action.eval);
    let json: string;
    try {
      json = JSON.stringify(value ?? null);
    } catch {
      json = String(value);
    }
    entry.result = truncate(json ?? "undefined", 1500, "eval result");
  }
}

interface BenchSnapshot {
  present: boolean;
  state: unknown;
  pos: unknown;
  stateJson: string;
}

/**
 * Compact __bench snapshot (string-expression evaluate — see the esbuild
 * note in probes.ts: serialized closures with named inner bindings throw
 * in-page, string expressions never transform).
 */
async function snapshotBench(page: Page): Promise<BenchSnapshot> {
  let raw: { present: boolean; state: unknown; pos: unknown };
  try {
    raw = (await page.evaluate(`(() => {
      const b = window.__bench;
      if (!b || typeof b !== "object") return { present: false, state: null, pos: null };
      let state = null, pos = null;
      try { state = JSON.parse(JSON.stringify(typeof b.getState === "function" ? (b.getState() ?? null) : null)); }
      catch (e) { state = "error: " + String(e); }
      try { pos = JSON.parse(JSON.stringify(typeof b.getPlayerPosition === "function" ? (b.getPlayerPosition() ?? null) : null)); }
      catch (e) { pos = "error: " + String(e); }
      return { present: true, state, pos };
    })()`)) as { present: boolean; state: unknown; pos: unknown };
  } catch (e) {
    raw = { present: false, state: `snapshot failed: ${String(e).slice(0, 200)}`, pos: null };
  }
  return { ...raw, stateJson: JSON.stringify(raw.state) };
}
