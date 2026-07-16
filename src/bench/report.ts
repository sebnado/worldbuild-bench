import fs from "node:fs";
import path from "node:path";
import { loadRegistry } from "../providers/index.js";
import { packageRoot } from "../util/paths.js";
import { RunResultJson, listTasks } from "./run.js";

/** Merge per-run result.json into WorldBuild round JSON (site schema v2). */

export interface RoundTrack {
  slug: string;
  name: string;
  brief: string;
}

export interface RoundResult {
  model_slug: string;
  model_name: string;
  provider: string;
  track_slug: string;
  status: "pass" | "fail" | "timeout";
  duration_s: number;
  cost_usd: number | null;
  est_cost_usd: number | null;
  tokens_in: number | null;
  tokens_in_cached: number | null;
  tokens_out: number | null;
  code_lines: number;
  code_files: number;
  tool_calls: number | null;
  subagents: number | null;
  playability: number | null;
  world_coherence: number | null;
  gates: Record<string, boolean> | null;
  screenshots: string[];
  game_id: string | null;
  served_model_ids: string[];
  /** Present only in --allow-mixed-budgets rounds. */
  budget_usd?: number;
  budget_wall_mins?: number;
}

export interface RoundJson {
  schema: 2;
  slug: string;
  title: string;
  date: string;
  harness: { name: "worldbuild-bench"; version: string; repo_url: string };
  budgets: { wall_clock_mins: number; usd_cap: number | null };
  tracks: RoundTrack[];
  results: RoundResult[];
}

export const REPO_URL = "https://github.com/sebnado/worldbuild-bench";

function harnessVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** First body paragraph of TASK.md after the title. */
export function taskBrief(taskSlug: string): string {
  const file = path.join(packageRoot(), "tasks", taskSlug, "TASK.md");
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const para: string[] = [];
  let pastTitle = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("#")) {
      if (pastTitle && para.length > 0) break;
      pastTitle = true;
      continue;
    }
    if (t === "") {
      if (para.length > 0) break;
      continue;
    }
    if (pastTitle) para.push(t);
  }
  return para.join(" ");
}

/** pass = loads+webgl+renders; timeout = wall-clock exhausted; else fail. */
export function runStatus(r: RunResultJson): "pass" | "fail" | "timeout" {
  const items = new Map((r.gates?.items ?? []).map((g) => [g.id, g.pass]));
  const runs = items.get("loads") === true && items.get("webgl_canvas") === true && items.get("renders") === true;
  if (runs) return "pass";
  if ((r.agent.budget_exhausted ?? "").includes("wall-clock")) return "timeout";
  return "fail";
}

export function resultToRoundEntry(
  r: RunResultJson,
  opts: { includeBudgets?: boolean } = {},
): RoundResult {
  const gates: Record<string, boolean> = {};
  for (const g of r.gates?.items ?? []) gates[g.id] = g.pass;
  for (const g of r.gates?.coherence_items ?? []) gates[`wc_${g.id}`] = g.pass;
  const toolCalls = Object.values(r.agent.tool_calls).reduce((a, b) => a + b, 0);
  return {
    model_slug: r.model.id,
    model_name: r.model.name,
    provider: r.model.provider,
    track_slug: r.task,
    status: runStatus(r),
    duration_s: r.wall_clock_s,
    cost_usd: r.agent.error && r.agent.cost_usd === 0 ? null : r.agent.cost_usd,
    est_cost_usd: r.agent.est_cost_usd ?? null,
    tokens_in: r.agent.tokens_in,
    tokens_in_cached: r.agent.tokens_in_cached ?? null,
    tokens_out: r.agent.tokens_out,
    code_lines: r.code.lines,
    code_files: r.code.files,
    tool_calls: toolCalls,
    subagents: r.agent.subagents_spawned,
    playability: r.gates ? r.gates.playability : null,
    world_coherence: r.gates ? r.gates.world_coherence : null,
    gates: r.gates ? gates : null,
    screenshots: r.screenshots.map((s) => `${r.run_id}/${s}`),
    game_id: null,
    served_model_ids: r.model.served_model_ids ?? [],
    ...(opts.includeBudgets
      ? { budget_usd: r.budgets.max_usd, budget_wall_mins: r.budgets.max_wall_mins }
      : {}),
  };
}

export interface ReportOptions {
  round: string;
  title?: string;
  date?: string;
  /** Explicit run directories; default: every runs/<dir> with a result.json. */
  runDirs?: string[];
  runsDir?: string;
  out?: string;
  /**
   * Allow mixed budgets in one round (writes per-result budgets). Without
   * this, mixed budgets throw — averaging unequal budgets corrupts efficiency.
   */
  allowMixedBudgets?: boolean;
}

export function collectRunResults(opts: ReportOptions): RunResultJson[] {
  let dirs = opts.runDirs;
  if (!dirs || dirs.length === 0) {
    const root = opts.runsDir ?? path.join(packageRoot(), "runs");
    if (!fs.existsSync(root)) return [];
    dirs = fs
      .readdirSync(root)
      .sort()
      .map((d) => path.join(root, d))
      // Default scan is over run *directories* only — never re-ingest a
      // previously written round-*.json (or any stray file) sitting in runs/.
      .filter((d) => fs.statSync(d).isDirectory());
  }
  const results: RunResultJson[] = [];
  for (const d of dirs) {
    const file = fs.statSync(d).isDirectory() ? path.join(d, "result.json") : d;
    if (!fs.existsSync(file)) continue;
    results.push(JSON.parse(fs.readFileSync(file, "utf8")) as RunResultJson);
  }
  return results;
}

export function buildRound(opts: ReportOptions): RoundJson {
  const results = collectRunResults(opts);
  if (results.length === 0) {
    throw new Error("no run results found — pass run directories or populate runs/ with wb run");
  }
  const trackSlugs = [...new Set(results.map((r) => r.task))].sort();
  const known = new Set(listTasks());
  const tracks: RoundTrack[] = trackSlugs.map((slug) => ({
    slug,
    name: titleCase(slug),
    brief: known.has(slug) ? taskBrief(slug) : "",
  }));
  const usdCaps = [...new Set(results.map((r) => r.budgets.max_usd))].sort((a, b) => a - b);
  const wallCaps = [...new Set(results.map((r) => r.budgets.max_wall_mins))].sort((a, b) => a - b);
  if ((usdCaps.length > 1 || wallCaps.length > 1) && !opts.allowMixedBudgets) {
    throw new Error(
      `refusing to merge runs with different budgets into one round ` +
        `(budget_usd: [${usdCaps.join(", ")}]; budget_wall_mins: [${wallCaps.join(", ")}]). ` +
        `Results under unequal budgets are not comparable. Pass --allow-mixed-budgets ` +
        `to merge anyway — per-result budgets will then be included in the JSON.`,
    );
  }
  const includeBudgets = opts.allowMixedBudgets === true;
  return {
    schema: 2,
    slug: opts.round,
    title: opts.title ?? `WorldBuild Bench — ${titleCase(opts.round)}`,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    harness: { name: "worldbuild-bench", version: harnessVersion(), repo_url: REPO_URL },
    budgets: {
      wall_clock_mins: Math.max(...wallCaps, 0),
      usd_cap: usdCaps.length > 0 ? Math.max(...usdCaps) : null,
    },
    tracks,
    results: results.map((r) => resultToRoundEntry(r, { includeBudgets })),
  };
}

export function writeRound(opts: ReportOptions): string {
  const round = buildRound(opts);
  const out = opts.out ?? path.join(packageRoot(), "runs", `round-${opts.round}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(round, null, 2) + "\n");
  return out;
}

/** wb models: registry summary rows. */
export function modelRows(): Array<Record<string, string>> {
  return loadRegistry().map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    model: m.provider_model_id,
    base_url: m.base_url,
    key: m.api_key_env,
    "in $/Mtok": m.pricing.input_per_mtok.toString(),
    "out $/Mtok": m.pricing.output_per_mtok.toString(),
  }));
}
