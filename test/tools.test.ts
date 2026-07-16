import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool, violatesJail } from "../src/tools/bash.js";
import { editFileTool, writeFileTool, readFileTool } from "../src/tools/fs.js";
import { resolveInside } from "../src/util/paths.js";
import { BudgetTracker } from "../src/agent/budget.js";
import { Transcript } from "../src/agent/transcript.js";
import { ToolContext, runTool } from "../src/tools/index.js";
import { updateTasksTool } from "../src/tools/tasks.js";
import { playGameTool } from "../src/tools/play_game.js";
import { scoreProbe, NO_BENCH_CAP } from "../src/bench/gates.js";
import { ProbeReport } from "../src/bench/probes.js";

function ctxFor(workspace: string): ToolContext {
  return {
    workspace,
    depth: 0,
    budget: new BudgetTracker(),
    transcript: new Transcript(null, true),
  };
}

test("bash jail: rejects traversal and outside absolute paths", () => {
  const ws = "/tmp/ws";
  assert.ok(violatesJail("cat ../secrets", ws));
  assert.ok(violatesJail("cat /etc/passwd", ws));
  assert.ok(violatesJail("echo x > /home/user/file", ws));
  // Bare "/" must be rejected — `ln -s / rootlink` would expose the whole
  // filesystem through the workspace.
  assert.ok(violatesJail("ln -s / rootlink", ws));
  assert.equal(violatesJail("ls js/ && cat index.html", ws), null);
  assert.equal(violatesJail(`cat ${ws}/index.html`, ws), null);
  assert.equal(violatesJail("echo hi > /dev/null", ws), null);
});

test("bash tool: sanitized env — provider keys are not inherited", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bashenv-"));
  const ctx = ctxFor(ws);
  // Fake values only — never real keys. Set in the parent process, then
  // prove the spawned shell cannot see them.
  const fakes: Record<string, string> = {
    ANTHROPIC_API_KEY: "fake-anthropic-key-must-not-leak",
    OPENAI_API_KEY: "fake-openai-key-must-not-leak",
    GEMINI_API_KEY: "fake-gemini-key-must-not-leak",
    OPENROUTER_API_KEY: "fake-openrouter-key-must-not-leak",
    GROQ_API_KEY: "fake-groq-key-must-not-leak",
    CEREBRAS_API_KEY: "fake-cerebras-key-must-not-leak",
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(fakes)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const envOut = await bashTool.execute({ command: "env" }, ctx);
    assert.doesNotMatch(
      envOut,
      /ANTHROPIC|OPENAI|GEMINI|OPENROUTER|GROQ|CEREBRAS/i,
      "no provider key material may reach the child environment",
    );
    for (const v of Object.values(fakes)) {
      assert.ok(!envOut.includes(v), "key value leaked into bash env");
    }
    assert.match(envOut, /(^|\n)PATH=/, "PATH must survive the allowlist");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  fs.rmSync(ws, { recursive: true, force: true });
});

test("bash tool: $HOME and ~ resolve to the workspace, not the real home", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bashhome-"));
  const ctx = ctxFor(ws);
  const out = await bashTool.execute({ command: "echo $HOME; echo ~; echo $TMPDIR" }, ctx);
  const [home, tilde, tmpdir] = out.trim().split("\n");
  assert.equal(home, ws);
  assert.equal(tilde, ws);
  assert.equal(tmpdir, path.join(ws, ".tmp"));
  assert.notEqual(home, os.homedir());
  assert.ok(fs.existsSync(path.join(ws, ".tmp")), "workspace TMPDIR is created");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("resolveInside: allows inside, throws on escape", () => {
  const root = "/tmp/ws";
  assert.equal(resolveInside(root, "a/b.txt"), "/tmp/ws/a/b.txt");
  assert.equal(resolveInside(root, "."), "/tmp/ws");
  assert.throws(() => resolveInside(root, "../outside.txt"));
  assert.throws(() => resolveInside(root, "/etc/passwd"));
});

test("fs jail: symlinks pointing outside the workspace are rejected", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-jail-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  // Symlinks created directly (not via the tools) — the jail must still hold.
  fs.symlinkSync(outside, path.join(ws, "escdir"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "escfile.txt"));
  fs.symlinkSync(path.join(outside, "not-yet-created.txt"), path.join(ws, "dangling.txt"));
  const ctx = ctxFor(ws);

  // read through a directory symlink and a file symlink
  await assert.rejects(
    () => readFileTool.execute({ path: "escdir/secret.txt" }, ctx),
    /escapes workspace/,
  );
  await assert.rejects(() => readFileTool.execute({ path: "escfile.txt" }, ctx), /escapes workspace/);

  // write through a directory symlink, a file symlink, and a dangling symlink
  await assert.rejects(
    () => writeFileTool.execute({ path: "escdir/pwned.txt", content: "x" }, ctx),
    /escapes workspace/,
  );
  await assert.rejects(
    () => writeFileTool.execute({ path: "escfile.txt", content: "x" }, ctx),
    /escapes workspace/,
  );
  await assert.rejects(
    () => writeFileTool.execute({ path: "dangling.txt", content: "x" }, ctx),
    /escapes workspace/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "top secret");
  assert.ok(!fs.existsSync(path.join(outside, "not-yet-created.txt")));

  // symlinks that stay inside the workspace still work
  fs.writeFileSync(path.join(ws, "real.txt"), "ok");
  fs.symlinkSync(path.join(ws, "real.txt"), path.join(ws, "alias.txt"));
  assert.equal(await readFileTool.execute({ path: "alias.txt" }, ctx), "ok");

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("write_file: append mode builds a file across calls", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-append-"));
  const ctx = ctxFor(ws);
  await writeFileTool.execute({ path: "big.md", content: "part1\n" }, ctx);
  const out = await writeFileTool.execute({ path: "big.md", content: "part2\n", append: true }, ctx);
  assert.match(out, /appended 6 bytes/);
  // append to a not-yet-existing file just creates it
  await writeFileTool.execute({ path: "new.md", content: "x", append: true }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, "big.md"), "utf8"), "part1\npart2\n");
  assert.equal(fs.readFileSync(path.join(ws, "new.md"), "utf8"), "x");
  fs.rmSync(ws, { recursive: true, force: true });
});

test("runTool: unparseable (__raw) arguments get a truncation-aware error", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-raw-"));
  const ctx = ctxFor(ws);
  const { runTool } = await import("../src/tools/index.js");
  const res = await runTool(writeFileTool, { __raw: '{"path": "PRD.md", "content": "# truncated…' }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.output, /output-token limit/);
  assert.match(res.output, /append: true/);
  // a plain schema violation still reports the zod error
  const plain = await runTool(writeFileTool, { path: "" }, ctx);
  assert.equal(plain.isError, true);
  assert.match(plain.output, /invalid input for write_file/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("edit_file: exact match, uniqueness, replace_all", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fs-"));
  const ctx = ctxFor(ws);
  await writeFileTool.execute({ path: "f.txt", content: "aaa bbb aaa" }, ctx);

  const notFound = await editFileTool.execute(
    { path: "f.txt", old_string: "zzz", new_string: "y" },
    ctx,
  );
  assert.match(notFound, /not found/);

  const ambiguous = await editFileTool.execute(
    { path: "f.txt", old_string: "aaa", new_string: "y" },
    ctx,
  );
  assert.match(ambiguous, /appears 2 times/);

  await editFileTool.execute(
    { path: "f.txt", old_string: "aaa", new_string: "ccc", replace_all: true },
    ctx,
  );
  const content = await readFileTool.execute({ path: "f.txt" }, ctx);
  assert.equal(content, "ccc bbb ccc");
  fs.rmSync(ws, { recursive: true, force: true });
});

function probeFixture(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    url: "http://127.0.0.1/x",
    loadOk: true,
    loadError: null,
    consoleErrors: [],
    pageErrors: [],
    canvasCount: 1,
    canvasHasGlContext: true,
    webglAvailable: true,
    screenshot2s: null,
    screenshot10s: null,
    rendered2s: true,
    rendered10s: true,
    fps: { avgFps: 60, frames: 120, sampleMs: 2000 },
    input: { dispatched: ["w"], benchStateChanged: true, playerMoved: true, screenshotChanged: true },
    bench: {
      present: true,
      methods: {
        getState: true,
        reset: true,
        getPlayerPosition: true,
        getCameraInfo: true,
        getEntities: true,
        getObjectiveStatus: true,
      },
      calls: {},
    },
    coherence: {
      positionSamples: [],
      positionSane: true,
      cameraSane: true,
      entitiesQueryOk: true,
      stateEvolves: true,
      resetReturns: true,
    },
    durationMs: 15000,
    ...overrides,
  };
}

test("gates: perfect probe scores 100/100", () => {
  const r = scoreProbe(probeFixture());
  assert.equal(r.playability, 100);
  assert.equal(r.worldCoherence, 100);
  assert.equal(r.capped, false);
});

test("gates: missing __bench caps playability and zeroes coherence", () => {
  const r = scoreProbe(
    probeFixture({
      bench: { present: false, methods: {}, calls: {} },
      coherence: {
        positionSamples: [],
        positionSane: null,
        cameraSane: null,
        entitiesQueryOk: null,
        stateEvolves: null,
        resetReturns: null,
      },
      input: { dispatched: ["w"], benchStateChanged: null, playerMoved: null, screenshotChanged: true },
    }),
  );
  assert.equal(r.capped, true);
  assert.equal(r.playability, NO_BENCH_CAP);
  assert.equal(r.worldCoherence, 0);
});

// ---------------------------------------------------------------------------
// update_tasks

test("update_tasks: replaces the list, renders statuses, mutates the ctx store", async () => {
  const ctx: ToolContext = { ...ctxFor("/tmp/ws"), tasks: { list: [] } };
  const out1 = (await updateTasksTool.execute(
    {
      tasks: [
        { title: "Write PRD", status: "done" },
        { title: "Build world module", status: "in_progress" },
        { title: "Integrate + playtest", status: "pending" },
      ],
    },
    ctx,
  )) as string;
  assert.match(out1, /3 items: 1 done, 1 in_progress, 1 pending/);
  assert.match(out1, /\[x\] Write PRD/);
  assert.match(out1, /\[>\] Build world module/);
  assert.match(out1, /\[ \] Integrate \+ playtest/);
  assert.equal(ctx.tasks!.list.length, 3);

  const out2 = (await updateTasksTool.execute({ tasks: [] }, ctx)) as string;
  assert.match(out2, /cleared/);
  assert.equal(ctx.tasks!.list.length, 0);
});

test("update_tasks: invalid status is a friendly validation error", async () => {
  const ctx: ToolContext = { ...ctxFor("/tmp/ws"), tasks: { list: [] } };
  const r = await runTool(updateTasksTool, { tasks: [{ title: "x", status: "doing" }] }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.output, /invalid input for update_tasks/);
  assert.equal(ctx.tasks!.list.length, 0, "a rejected update must not touch the list");
});

// ---------------------------------------------------------------------------
// play_game (integration: real headless browser against a tiny __bench page)

const PLAY_TEST_HTML = `<!doctype html>
<html><body style="margin:0"><div style="width:100vw;height:100vh;background:#246"></div>
<script>
  const state = { x: 0, clicks: 0, fired: 0 };
  let held = false;
  addEventListener("keydown", (e) => {
    if (e.key === "w") held = true;
    if (e.key === " ") state.fired++;
  });
  addEventListener("keyup", (e) => { if (e.key === "w") held = false; });
  addEventListener("mousedown", () => state.clicks++);
  setInterval(() => { if (held) state.x += 1; }, 25);
  window.__bench = {
    getState: () => ({ ...state }),
    getPlayerPosition: () => ({ x: state.x, y: 0, z: 0 }),
    reset: () => { state.x = 0; state.clicks = 0; state.fired = 0; },
    getCameraInfo: () => ({ position: { x: 0, y: 5, z: 10 } }),
    getEntities: () => [],
    getObjectiveStatus: () => ({ done: false }),
  };
</script></body></html>`;

test("play_game: actions drive the page and state_changed reflects cause and effect", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wb-play-"));
  fs.writeFileSync(path.join(ws, "index.html"), PLAY_TEST_HTML);
  const ctx = ctxFor(ws);
  const out = await playGameTool.execute(
    {
      actions: [
        { click: [640, 360] },
        { press: "w", ms: 600 },
        { press: "Space" },
        { screenshot: true },
        { eval: "window.__bench.getState().fired" },
      ],
    },
    ctx,
  );
  assert.ok(typeof out === "object" && out !== null && "text" in out);
  const o = out as { text: string; images?: unknown[] };
  const report = JSON.parse(o.text);
  assert.equal(report.loaded, true);
  assert.equal(report.bench_present, true);
  assert.equal(report.steps.length, 5);

  const [click, hold, fire, shot, evalStep] = report.steps;
  assert.equal(click.state_changed, true, "click increments state.clicks");
  assert.equal(hold.state_changed, true, "holding w moves the player");
  assert.ok(hold.player_pos.x > 0, "player_pos should have advanced during the hold");
  assert.equal(fire.state_changed, true, "Space increments state.fired");
  assert.equal(shot.screenshot, "captured");
  assert.equal(evalStep.result, "1");

  assert.equal(report.screenshots_taken, 1);
  assert.equal(o.images?.length, 1, "screenshot action attaches one image");
  assert.equal(report.final.state.fired, 1);
  fs.rmSync(ws, { recursive: true, force: true });
});
