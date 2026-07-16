import fs from "node:fs";
import path from "node:path";
import { Agent, AgentStats } from "../agent/agent.js";
import { BudgetTracker, DEFAULT_LIMITS } from "../agent/budget.js";
import { Transcript } from "../agent/transcript.js";
import { ModelEntry, getModel, providerFor, referenceCostOf } from "../providers/index.js";
import { defaultTools } from "../tools/all.js";
import { packageRoot, timestampSlug } from "../util/paths.js";
import { GateResult, runGates } from "./gates.js";

export interface RunOptions {
  task: string;
  model: string;
  maxUsd?: number;
  maxWallMins?: number;
  maxTurns?: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  quiet?: boolean;
  /** Override the runs/ output root (tests). */
  runsDir?: string;
}

export interface RunResultJson {
  schema: 1;
  run_id: string;
  created_at: string;
  task: string;
  model: {
    id: string;
    name: string;
    provider: string;
    provider_model_id: string;
    reasoning_effort?: string;
    vision: boolean;
    served_model_ids: string[];
  };
  budgets: { max_usd: number; max_wall_mins: number; max_turns: number; max_tokens: number };
  wall_clock_s: number;
  agent: {
    turns: number;
    tokens_in: number;
    tokens_in_cached: number;
    tokens_out: number;
    cost_usd: number;
    /** List-price token cost (independent of provider-reported cost). */
    est_cost_usd: number;
    tool_calls: Record<string, number>;
    subagents_spawned: number;
    images_sent: number;
    budget_exhausted: string | null;
    error: string | null;
    final_text: string;
  };
  code: { files: number; lines: number };
  gates: {
    playability: number;
    world_coherence: number;
    bench_present: boolean;
    capped: boolean;
    items: Array<{ id: string; weight: number; pass: boolean; detail: string }>;
    coherence_items: Array<{ id: string; weight: number; pass: boolean; detail: string }>;
  } | null;
  gate_error: string | null;
  screenshots: string[];
}

export function listTasks(): string[] {
  const dir = path.join(packageRoot(), "tasks");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "TASK.md")))
    .sort();
}

export function readTaskBrief(task: string): string {
  const file = path.join(packageRoot(), "tasks", task, "TASK.md");
  if (!fs.existsSync(file)) {
    throw new Error(`unknown task "${task}". Available tasks: ${listTasks().join(", ")}`);
  }
  return fs.readFileSync(file, "utf8");
}

export function seedWorkspace(workspace: string, task: string): void {
  const root = packageRoot();
  const scaffold = path.join(root, "scaffold");
  const libSentinels = ["three", "rapier"].map((lib) =>
    path.join(scaffold, "lib", lib, "VERSION"),
  );
  if (!libSentinels.every((sentinel) => fs.existsSync(sentinel))) {
    throw new Error(
      "scaffold/lib is not populated (three + rapier) — run `npm run fetch-three` (scripts/fetch-three.sh) first",
    );
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.cpSync(scaffold, workspace, { recursive: true });
  fs.cpSync(path.join(root, "skills"), path.join(workspace, "skills"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "TASK.md"), readTaskBrief(task));
}

const CODE_EXCLUDE_DIRS = new Set(["lib", "skills", "node_modules", ".git", ".playtest", ".tmp"]);
const CODE_EXTS = new Set([".js", ".mjs", ".ts", ".html", ".css", ".json", ".glsl"]);

/** Model-authored code only (excludes seeded lib/ and skills/). */
export function codeStats(workspace: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!CODE_EXCLUDE_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (entry.name === "TASK.md") continue;
      if (!CODE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      files += 1;
      try {
        lines += fs.readFileSync(path.join(dir, entry.name), "utf8").split("\n").length;
      } catch {
        /* binary or unreadable — count the file, skip lines */
      }
    }
  };
  if (fs.existsSync(workspace)) walk(workspace);
  return { files, lines };
}

export function gateResultToJson(g: GateResult): NonNullable<RunResultJson["gates"]> {
  return {
    playability: g.playability,
    world_coherence: g.worldCoherence,
    bench_present: g.benchPresent,
    capped: g.capped,
    items: g.gates.map(({ id, weight, pass, detail }) => ({ id, weight, pass, detail })),
    coherence_items: g.coherenceGates.map(({ id, weight, pass, detail }) => ({
      id,
      weight,
      pass,
      detail,
    })),
  };
}

function listScreenshots(runDir: string): string[] {
  const dir = path.join(runDir, "screenshots");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => `screenshots/${f}`);
}

export function runIdFor(task: string, modelId: string, timestamp = timestampSlug()): string {
  return `${timestamp}-${task}-${modelId}`;
}

export function resultModelMetadata(
  model: ModelEntry,
  servedModelIds: string[],
): RunResultJson["model"] {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    provider_model_id: model.provider_model_id,
    ...(model.reasoning_effort ? { reasoning_effort: model.reasoning_effort } : {}),
    vision: model.vision === true,
    served_model_ids: servedModelIds,
  };
}

/** Seed workspace, run agent, score gates, write result.json. */
export async function runBench(opts: RunOptions): Promise<{ runDir: string; result: RunResultJson }> {
  const model: ModelEntry = getModel(opts.model);
  if (opts.effort) model.reasoning_effort = opts.effort;
  const provider = providerFor(model);
  const brief = readTaskBrief(opts.task);

  const runsRoot = opts.runsDir ?? path.join(packageRoot(), "runs");
  const runId = runIdFor(opts.task, model.id);
  const runDir = path.join(runsRoot, runId);
  const workspace = path.join(runDir, "workspace");
  seedWorkspace(workspace, opts.task);

  const budget = new BudgetTracker({
    maxUsd: opts.maxUsd ?? DEFAULT_LIMITS.maxUsd,
    maxWallMs: (opts.maxWallMins ?? DEFAULT_LIMITS.maxWallMs / 60_000) * 60_000,
    maxTurns: opts.maxTurns ?? DEFAULT_LIMITS.maxTurns,
    maxTokens: opts.maxTokens ?? DEFAULT_LIMITS.maxTokens,
  });
  const transcript = new Transcript(path.join(runDir, "transcript.jsonl"), opts.quiet ?? false);

  console.log(`run ${runId}`);
  console.log(
    `  task: ${opts.task}  model: ${model.id} (${model.provider_model_id})${model.reasoning_effort ? `  effort: ${model.reasoning_effort}` : ""}  vision: ${model.vision ? "on" : "off"}`,
  );
  console.log(
    `  budget: $${budget.limits.maxUsd}, ${Math.round(budget.limits.maxWallMs / 60_000)} min, ${budget.limits.maxTurns} turns, ${budget.limits.maxTokens} tokens`,
  );
  const started = Date.now();
  let stats: AgentStats = {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    toolCalls: {},
    subagentsSpawned: 0,
    imagesSent: 0,
    budgetExhausted: null,
    servedModels: [],
  };
  let finalText = "";
  let agentError: string | null = null;
  let agent: Agent | null = null;
  try {
    agent = new Agent({
      provider,
      model,
      tools: defaultTools(),
      workspace,
      budget,
      transcript,
    });
    const result = await agent.run(
      `Build the game described in the task brief below. The brief is also available at TASK.md in your workspace.\n\n${brief}`,
    );
    stats = result.stats;
    finalText = result.finalText;
  } catch (e: any) {
    agentError = e?.message ?? String(e);
    transcript.log("error", "runner", 0, { message: agentError ?? "unknown" });
    // Keep partial accounting so an abort doesn't zero out prior spend.
    if (agent) stats = agent.snapshotStats();
  }
  // Budget tracker includes concurrent subagents — prefer it on abort.
  stats.costUsd = Math.max(stats.costUsd, budget.usedUsd);
  const wallClockS = Math.round((Date.now() - started) / 1000);
  transcript.close();

  // Score even on agent crash so the run still gets an honest (low) score.
  let gates: RunResultJson["gates"] = null;
  let gateError: string | null = null;
  try {
    const g = await runGates(workspace, { screenshotDir: path.join(runDir, "screenshots") });
    gates = gateResultToJson(g);
  } catch (e: any) {
    gateError = e?.message ?? String(e);
  }

  const result: RunResultJson = {
    schema: 1,
    run_id: runId,
    created_at: new Date(started).toISOString(),
    task: opts.task,
    model: resultModelMetadata(model, stats.servedModels),
    budgets: {
      max_usd: budget.limits.maxUsd,
      max_wall_mins: Math.round(budget.limits.maxWallMs / 60_000),
      max_turns: budget.limits.maxTurns,
      max_tokens: budget.limits.maxTokens,
    },
    wall_clock_s: wallClockS,
    agent: {
      turns: stats.turns,
      tokens_in: stats.inputTokens,
      tokens_in_cached: stats.cachedInputTokens,
      tokens_out: stats.outputTokens,
      cost_usd: Number(stats.costUsd.toFixed(6)),
      est_cost_usd: Number(
        referenceCostOf(model, {
          inputTokens: stats.inputTokens,
          cachedInputTokens: stats.cachedInputTokens,
          outputTokens: stats.outputTokens,
        }).toFixed(6),
      ),
      tool_calls: stats.toolCalls,
      subagents_spawned: stats.subagentsSpawned,
      images_sent: stats.imagesSent,
      budget_exhausted: stats.budgetExhausted,
      error: agentError,
      final_text: finalText,
    },
    code: codeStats(workspace),
    gates,
    gate_error: gateError,
    screenshots: listScreenshots(runDir),
  };
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2) + "\n");

  console.log(`\nresult: ${path.join(runDir, "result.json")}`);
  const divergent = stats.servedModels.filter((m) => m !== model.provider_model_id);
  if (divergent.length > 0) {
    console.warn(
      `  WARNING: provider served ${divergent.join(", ")} — requested ${model.provider_model_id} (recorded in result.json served_model_ids)`,
    );
  }
  if (gates) {
    console.log(`  Playability:     ${gates.playability}/100${gates.capped ? " (capped: no __bench)" : ""}`);
    console.log(`  World Coherence: ${gates.world_coherence}/100`);
  } else {
    console.log(`  gates failed: ${gateError}`);
  }
  console.log(
    `  cost: $${result.agent.cost_usd}  turns: ${stats.turns}  wall: ${wallClockS}s  code: ${result.code.files} files / ${result.code.lines} lines`,
  );
  return { runDir, result };
}
