import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  RUN_LOCK_FILE,
  RESUME_STATE_FILE,
  RunResultJson,
  runBench,
  resumeBench,
  resumeBudgetDefaults,
} from "../src/bench/run.js";

const BUDGETS = {
  max_usd: 100,
  max_wall_mins: 360,
  max_turns: 10_000,
  max_tokens: 1_000_000_000,
};

function checkpointV2(resumeCount = 0) {
  return {
    schema: 2,
    checkpointed_at: "2026-07-17T00:00:01.000Z",
    run: {
      run_id: "20260717-000000-arena-combat-kimi-k3",
      created_at: "2026-07-17T00:00:00.000Z",
      task: "arena-combat",
      model_id: "kimi-k3",
      model_provider: "openai",
      provider_model_id: "kimi-k3",
      provider_base_url: "https://api.moonshot.ai/v1",
      provider_api_key_env: "MOONSHOT_API_KEY",
      budgets: BUDGETS,
      segment_budgets: BUDGETS,
      wall_clock_s: 1,
      resume_count: resumeCount,
    },
    messages: [
      { role: "user", content: [{ type: "text", text: "build" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "write_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ],
    finalText: "working",
    stats: {
      turns: 1,
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      costUsd: 0.001,
      toolCalls: { write_file: 1 },
      subagentsSpawned: 0,
      imagesSent: 0,
      budgetExhausted: null,
      servedModels: ["kimi-k3"],
    },
    ownTurns: 1,
    directChildren: 0,
    tasks: [],
  };
}

function makeInterruptedRun(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-resume-"));
  fs.mkdirSync(path.join(dir, "workspace"));
  fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(checkpointV2()));
  return dir;
}

test("resume budgets: repeated default resumes reuse the last segment cap", () => {
  const afterFirstResume = {
    budgets: {
      max_usd: 200,
      max_wall_mins: 720,
      max_turns: 20_000,
      max_tokens: 2_000_000_000,
    },
    resumed: {
      count: 1,
      last_added_usd: 100,
      last_added_wall_mins: 360,
      last_added_turns: 10_000,
      last_added_tokens: 1_000_000_000,
      prior_cost_usd: 12,
    },
  } as Pick<RunResultJson, "budgets" | "resumed">;
  assert.deepEqual(resumeBudgetDefaults(afterFirstResume), BUDGETS);
});

test("resume budgets: older resumed results get conservative per-segment defaults", () => {
  const legacyResumed = {
    budgets: { max_usd: 30, max_wall_mins: 90, max_turns: 300, max_tokens: 3000 },
    resumed: { count: 2, last_added_usd: 10, prior_cost_usd: 4 },
  } as Pick<RunResultJson, "budgets" | "resumed">;
  assert.deepEqual(resumeBudgetDefaults(legacyResumed), {
    max_usd: 10,
    max_wall_mins: 30,
    max_turns: 100,
    max_tokens: 1000,
  });
});

test("resume: schema 2 checkpoint remains usable without result.json and releases its lock", async () => {
  const dir = makeInterruptedRun();
  const saved = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    await assert.rejects(() => resumeBench({ runDir: dir, quiet: true }), /missing API key/);
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false, "failed resume releases lock");
  } finally {
    if (saved === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: schema 2 checkpoint recovers past a partially written result.json", async () => {
  const dir = makeInterruptedRun();
  fs.writeFileSync(path.join(dir, "result.json"), '{"schema":1,"run_id":');
  const saved = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    await assert.rejects(() => resumeBench({ runDir: dir, quiet: true }), /missing API key/);
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    if (saved === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: schema 2 checkpoint ignores structurally malformed result JSON", async () => {
  const dir = makeInterruptedRun();
  fs.writeFileSync(path.join(dir, "result.json"), "{}\n");
  const saved = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    await assert.rejects(() => resumeBench({ runDir: dir, quiet: true }), /missing API key/);
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    if (saved === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: schema 2 accepts a durable interrupted-tool boundary", async () => {
  const dir = makeInterruptedRun();
  const state = checkpointV2() as any;
  state.messages.pop();
  state.inFlightToolCalls = [
    {
      call: state.messages.at(-1).content[0],
      status: "running",
    },
  ];
  fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(state));
  const saved = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    await assert.rejects(() => resumeBench({ runDir: dir, quiet: true }), /missing API key/);
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    if (saved === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: active process lock blocks concurrent workspace mutation", async () => {
  const dir = makeInterruptedRun();
  fs.writeFileSync(
    path.join(dir, RUN_LOCK_FILE),
    JSON.stringify({ pid: process.pid, started_at: "now", token: "other" }),
  );
  try {
    await assert.rejects(
      () => resumeBench({ runDir: dir, quiet: true }),
      new RegExp(`already active in process ${process.pid}`),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run: fresh process holds the same lease that blocks resume", async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-live-run-"));
  let requests = 0;
  const server = http.createServer(async (_req, res) => {
    requests += 1;
    const reply =
      requests === 1
        ? {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "slow_1",
                      type: "function",
                      function: { name: "bash", arguments: JSON.stringify({ command: "sleep 1" }) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }
        : {
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const savedKey = process.env.MOONSHOT_API_KEY;
  const savedBase = process.env.MOONSHOT_BASE_URL;
  let running: ReturnType<typeof runBench> | null = null;
  process.env.MOONSHOT_API_KEY = "test-key";
  process.env.MOONSHOT_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    running = runBench({
      task: "arena-combat",
      model: "kimi-k3",
      runsDir,
      maxUsd: 1,
      maxWallMins: 1,
      maxTurns: 10,
      maxTokens: 100_000,
      quiet: true,
    });
    let runDir = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const entries = fs.readdirSync(runsDir);
      if (entries.length === 1) {
        const candidate = path.join(runsDir, entries[0]);
        if (fs.existsSync(path.join(candidate, RESUME_STATE_FILE))) {
          runDir = candidate;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(runDir, "fresh run must checkpoint while its tool is still active");
    assert.equal(fs.existsSync(path.join(runDir, RUN_LOCK_FILE)), true);
    await assert.rejects(
      () => resumeBench({ runDir, quiet: true }),
      /run is already active in process/,
    );
    await running;
    assert.equal(fs.existsSync(path.join(runDir, RUN_LOCK_FILE)), false);
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(runDir, RESUME_STATE_FILE), "utf8"),
    );
    assert.equal(checkpoint.run.provider_base_url, `http://127.0.0.1:${port}/v1`);
    assert.equal(checkpoint.run.provider_api_key_env, "MOONSHOT_API_KEY");
  } finally {
    await running?.catch(() => undefined);
    if (savedKey === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.MOONSHOT_BASE_URL;
    else process.env.MOONSHOT_BASE_URL = savedBase;
    server.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test("resume: refuses a registry mapping that differs from the pinned provider model", async () => {
  const dir = makeInterruptedRun();
  const state = checkpointV2() as any;
  state.run.provider_model_id = "a-different-model";
  fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(state));
  try {
    await assert.rejects(
      () => resumeBench({ runDir: dir, quiet: true }),
      /model registry entry .* changed.*refusing an unsafe resume/,
    );
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: refuses an endpoint change even when provider and model ids still match", async () => {
  const dir = makeInterruptedRun();
  const state = checkpointV2() as any;
  state.run.provider_base_url = "https://openrouter.ai/api/v1";
  fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(state));
  try {
    await assert.rejects(
      () => resumeBench({ runDir: dir, quiet: true }),
      /model registry route .* changed.*refusing an unsafe resume/,
    );
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: early schema 2 checkpoints without route metadata remain compatible", async () => {
  const dir = makeInterruptedRun();
  const state = checkpointV2() as any;
  delete state.run.provider_base_url;
  delete state.run.provider_api_key_env;
  fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(state));
  const saved = process.env.MOONSHOT_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  try {
    await assert.rejects(() => resumeBench({ runDir: dir, quiet: true }), /missing API key/);
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    if (saved === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: legacy checkpoint without result.json fails with migration guidance", async () => {
  const dir = makeInterruptedRun();
  const legacy = checkpointV2() as any;
  legacy.schema = 1;
  delete legacy.run;
  delete legacy.checkpointed_at;
  fs.writeFileSync(path.join(dir, RESUME_STATE_FILE), JSON.stringify(legacy));
  try {
    await assert.rejects(() => resumeBench({ runDir: dir, quiet: true }), /legacy schema 1/);
    assert.equal(fs.existsSync(path.join(dir, RUN_LOCK_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
