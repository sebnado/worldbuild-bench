import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRound } from "../src/bench/report.js";
import { RunResultJson } from "../src/bench/run.js";

function fixtureResult(overrides: {
  run_id: string;
  max_usd?: number;
  max_wall_mins?: number;
  served_model_ids?: string[];
}): RunResultJson {
  return {
    schema: 1,
    run_id: overrides.run_id,
    created_at: "2026-07-03T00:00:00.000Z",
    task: "racing",
    model: {
      id: "mock-model",
      name: "Mock Model",
      provider: "anthropic",
      provider_model_id: "mock-1",
      served_model_ids: overrides.served_model_ids ?? ["mock-1"],
    },
    budgets: {
      max_usd: overrides.max_usd ?? 15,
      max_wall_mins: overrides.max_wall_mins ?? 60,
      max_turns: 200,
      max_tokens: 4_000_000,
    },
    wall_clock_s: 100,
    agent: {
      turns: 5,
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.5,
      tool_calls: { bash: 2, write_file: 3 },
      subagents_spawned: 0,
      budget_exhausted: null,
      error: null,
      final_text: "done",
    },
    code: { files: 3, lines: 200 },
    gates: null,
    gate_error: "not gated in tests",
    screenshots: [],
  };
}

/** Write result files and return their paths (collectRunResults accepts files). */
function writeResults(results: RunResultJson[]): { dir: string; files: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-report-"));
  const files = results.map((r) => {
    const f = path.join(dir, `${r.run_id}.json`);
    fs.writeFileSync(f, JSON.stringify(r, null, 2));
    return f;
  });
  return { dir, files };
}

test("report: served_model_ids survive into the round JSON", () => {
  const { dir, files } = writeResults([
    fixtureResult({ run_id: "r1", served_model_ids: ["mock-1", "mock-1-fallback"] }),
  ]);
  const round = buildRound({ round: "test-round", runDirs: files });
  assert.deepEqual(round.results[0].served_model_ids, ["mock-1", "mock-1-fallback"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("report: pre-0.1 result.json without served_model_ids still ingests", () => {
  const legacy = fixtureResult({ run_id: "r-legacy" }) as any;
  delete legacy.model.served_model_ids;
  const { dir, files } = writeResults([legacy]);
  const round = buildRound({ round: "test-round", runDirs: files });
  assert.deepEqual(round.results[0].served_model_ids, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("report: invocation credential metadata never crosses into round JSON", () => {
  const historical = fixtureResult({ run_id: "r-private-auth" }) as any;
  historical.model.auth_mode = "oauth";
  const { dir, files } = writeResults([historical]);
  const round = buildRound({ round: "test-round", runDirs: files });
  assert.equal("auth_mode" in round.results[0], false);
  assert.doesNotMatch(JSON.stringify(round), /auth_mode|oauth/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("report: mixed budgets throw without --allow-mixed-budgets", () => {
  const { dir, files } = writeResults([
    fixtureResult({ run_id: "r1", max_usd: 15 }),
    fixtureResult({ run_id: "r2", max_usd: 2 }),
  ]);
  assert.throws(
    () => buildRound({ round: "test-round", runDirs: files }),
    /different budgets.*allow-mixed-budgets/s,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("report: --allow-mixed-budgets merges and includes per-result budgets", () => {
  const { dir, files } = writeResults([
    fixtureResult({ run_id: "r1", max_usd: 15, max_wall_mins: 60 }),
    fixtureResult({ run_id: "r2", max_usd: 2, max_wall_mins: 10 }),
  ]);
  const round = buildRound({ round: "test-round", runDirs: files, allowMixedBudgets: true });
  assert.equal(round.results.length, 2);
  assert.equal(round.results[0].budget_usd, 15);
  assert.equal(round.results[0].budget_wall_mins, 60);
  assert.equal(round.results[1].budget_usd, 2);
  assert.equal(round.results[1].budget_wall_mins, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("report: uniform budgets merge without the flag and omit per-result budgets", () => {
  const { dir, files } = writeResults([
    fixtureResult({ run_id: "r1" }),
    fixtureResult({ run_id: "r2" }),
  ]);
  const round = buildRound({ round: "test-round", runDirs: files });
  assert.equal(round.results.length, 2);
  assert.equal(round.budgets.usd_cap, 15);
  assert.equal(round.budgets.wall_clock_mins, 60);
  assert.ok(!("budget_usd" in round.results[0]));
  fs.rmSync(dir, { recursive: true, force: true });
});
