import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  AgentCheckpoint,
  AgentRuntimeState,
  AgentStats,
  CheckpointToolCall,
} from "../agent/agent.js";
import { BudgetTracker, DEFAULT_LIMITS } from "../agent/budget.js";
import { Transcript } from "../agent/transcript.js";
import {
  ModelEntry,
  getModel,
  providerFor,
  providerRouteOf,
  referenceCostOf,
  setReasoningEffort,
} from "../providers/index.js";
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
    /** Root-only runtime counters; subtree turns remain in turns. */
    root_turns?: number;
    direct_children?: number;
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
  /** Present when this run was continued via `wb resume`. Totals above are cumulative. */
  resumed?: {
    count: number;
    last_added_usd: number;
    last_added_wall_mins?: number;
    last_added_turns?: number;
    last_added_tokens?: number;
    prior_cost_usd: number;
  };
}

/** Filename of the per-run resumable conversation snapshot (under runs/<id>/). */
export const RESUME_STATE_FILE = "resume-state.json";
// Keep the original filename so an older live resume process still excludes a
// newer fresh/resumed process; the lease now covers both lifecycle paths.
export const RUN_LOCK_FILE = "resume.lock";

interface ResumeStateCore {
  messages: AgentCheckpoint["messages"];
  finalText: string;
  stats: AgentStats;
  ownTurns: number;
  /** Optional only for checkpoints written by the first resume implementation. */
  directChildren?: number;
  tasks?: AgentCheckpoint["tasks"];
  inFlightToolCalls?: CheckpointToolCall[];
}

/** Legacy checkpoint: resumable only when a matching result.json also exists. */
interface ResumeStateFileV1 extends ResumeStateCore {
  schema: 1;
}

export interface ResumeRunMetadata {
  run_id: string;
  created_at: string;
  task: string;
  model_id: string;
  /** Exact invocation identity. Optional only for early schema-2 checkpoints. */
  model_provider?: ModelEntry["provider"];
  provider_model_id?: string;
  /** Resolved endpoint and credential selector; never contains the credential itself. */
  provider_base_url?: string;
  provider_api_key_env?: string;
  reasoning_effort?: string;
  /** Cumulative caps across every segment entered so far. */
  budgets: RunResultJson["budgets"];
  /** Cap of the segment that wrote this checkpoint; defaults for the next resume. */
  segment_budgets: RunResultJson["budgets"];
  /** Wall time through this checkpoint, including prior segments. */
  wall_clock_s: number;
  resume_count: number;
}

export interface ResumeStateFileV2 extends ResumeStateCore {
  schema: 2;
  checkpointed_at: string;
  run: ResumeRunMetadata;
}

type ResumeStateFile = ResumeStateFileV1 | ResumeStateFileV2;

/** Write JSON via a same-directory rename so readers never observe a partial file. */
function writeJsonAtomic(file: string, payload: unknown, mode?: number): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const options = mode === undefined ? {} : { mode };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", options);
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
}

/** Atomically persist a self-describing snapshot so process interruption is resumable. */
function writeCheckpoint(runDir: string, cp: AgentCheckpoint, run: ResumeRunMetadata): void {
  const file = path.join(runDir, RESUME_STATE_FILE);
  const payload: ResumeStateFileV2 = {
    schema: 2,
    checkpointed_at: new Date().toISOString(),
    run,
    messages: cp.messages,
    finalText: cp.finalText,
    stats: cp.stats,
    ownTurns: cp.ownTurns,
    directChildren: cp.directChildren,
    tasks: cp.tasks,
    ...(cp.inFlightToolCalls ? { inFlightToolCalls: cp.inFlightToolCalls } : {}),
  };
  writeJsonAtomic(file, payload, 0o600);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Exclusive lease for the full fresh/resumed run. Dead-process leases are reclaimed. */
function acquireRunLock(runDir: string): () => void {
  const file = path.join(runDir, RUN_LOCK_FILE);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | null = null;
    let created = false;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      created = true;
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), token }));
      fs.closeSync(fd);
      fd = null;
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(file, "utf8"));
          if (current?.token === token) fs.unlinkSync(file);
        } catch (e: any) {
          if (e?.code !== "ENOENT") {
            console.warn(`warning: could not release ${file}: ${e?.message ?? e}`);
          }
        }
      };
    } catch (e: any) {
      if (fd !== null) fs.closeSync(fd);
      if (created) {
        try {
          fs.unlinkSync(file);
        } catch (cleanupError: any) {
          if (cleanupError?.code !== "ENOENT") throw cleanupError;
        }
      }
      if (e?.code !== "EEXIST") throw e;
      let holder: { pid?: number; started_at?: string } = {};
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          `${RUN_LOCK_FILE} in ${runDir} is unreadable; verify no run is active, then remove it`,
        );
      }
      if (typeof holder.pid === "number" && isProcessAlive(holder.pid)) {
        throw new Error(
          `run is already active in process ${holder.pid}${holder.started_at ? ` (since ${holder.started_at})` : ""}`,
        );
      }
      try {
        fs.unlinkSync(file);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error(`could not acquire ${RUN_LOCK_FILE} in ${runDir}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBudgets(value: unknown): value is RunResultJson["budgets"] {
  if (!isRecord(value)) return false;
  return (
    Number.isFinite(value.max_usd) &&
    value.max_usd > 0 &&
    Number.isFinite(value.max_wall_mins) &&
    value.max_wall_mins > 0 &&
    Number.isFinite(value.max_turns) &&
    value.max_turns > 0 &&
    Number.isFinite(value.max_tokens) &&
    value.max_tokens > 0
  );
}

function validToolCalls(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((count) => Number.isInteger(count) && (count as number) >= 0)
  );
}

function validStats(value: unknown): value is AgentStats {
  if (!isRecord(value)) return false;
  return (
    Number.isFinite(value.turns) &&
    value.turns >= 0 &&
    Number.isFinite(value.inputTokens) &&
    value.inputTokens >= 0 &&
    Number.isFinite(value.cachedInputTokens) &&
    value.cachedInputTokens >= 0 &&
    Number.isFinite(value.outputTokens) &&
    value.outputTokens >= 0 &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    validToolCalls(value.toolCalls) &&
    Number.isFinite(value.subagentsSpawned) &&
    value.subagentsSpawned >= 0 &&
    Number.isFinite(value.imagesSent) &&
    value.imagesSent >= 0 &&
    (value.budgetExhausted === null || typeof value.budgetExhausted === "string") &&
    Array.isArray(value.servedModels) &&
    value.servedModels.every((m: unknown) => typeof m === "string")
  );
}

function validCheckpointToolCalls(value: unknown): value is CheckpointToolCall[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    if (!isRecord(item) || !["pending", "running", "completed"].includes(item.status)) {
      return false;
    }
    const call = item.call;
    if (
      !isRecord(call) ||
      call.type !== "tool_use" ||
      typeof call.id !== "string" ||
      typeof call.name !== "string"
    ) {
      return false;
    }
    if (
      item.images !== undefined &&
      (!Array.isArray(item.images) ||
        !item.images.every(
          (image: unknown) =>
            isRecord(image) &&
            typeof image.media_type === "string" &&
            typeof image.data === "string" &&
            typeof image.label === "string",
        ))
    ) {
      return false;
    }
    if (item.status !== "completed") return item.result === undefined;
    return (
      isRecord(item.result) &&
      item.result.type === "tool_result" &&
      item.result.tool_use_id === call.id &&
      typeof item.result.content === "string" &&
      (item.result.is_error === undefined || typeof item.result.is_error === "boolean")
    );
  });
}

function validTaskItems(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.title === "string" &&
        ["pending", "in_progress", "done"].includes(item.status),
    )
  );
}

function readResumeState(file: string, displayDir: string): ResumeStateFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`${RESUME_STATE_FILE} in ${displayDir} is not valid JSON: ${e?.message ?? e}`);
  }
  const rawRecord = isRecord(raw) ? raw : null;
  const lastMsg = rawRecord && Array.isArray(rawRecord.messages) ? rawRecord.messages.at(-1) : undefined;
  const hasInFlight = rawRecord?.inFlightToolCalls !== undefined;
  const inFlightValid =
    !hasInFlight || validCheckpointToolCalls(rawRecord?.inFlightToolCalls);
  const cleanBoundary =
    isRecord(lastMsg) &&
    lastMsg.role === "user" &&
    Array.isArray(lastMsg.content) &&
    lastMsg.content.some((b: any) => isRecord(b) && b.type === "tool_result");
  const interruptedBoundary =
    hasInFlight &&
    inFlightValid &&
    isRecord(lastMsg) &&
    lastMsg.role === "assistant" &&
    Array.isArray(lastMsg.content) &&
    (rawRecord?.inFlightToolCalls as CheckpointToolCall[]).every((state) =>
      lastMsg.content.some(
        (block: any) => isRecord(block) && block.type === "tool_use" && block.id === state.call.id,
      ),
    );
  const coreValid =
    isRecord(raw) &&
    (raw.schema === 1 || raw.schema === 2) &&
    Array.isArray(raw.messages) &&
    raw.messages.length > 0 &&
    (cleanBoundary || interruptedBoundary) &&
    inFlightValid &&
    typeof raw.finalText === "string" &&
    validStats(raw.stats) &&
    Number.isInteger(raw.ownTurns) &&
    raw.ownTurns >= 0 &&
    (raw.directChildren === undefined ||
      (Number.isInteger(raw.directChildren) && raw.directChildren >= 0)) &&
    (raw.tasks === undefined || validTaskItems(raw.tasks));
  let v2Valid = true;
  if (isRecord(raw) && raw.schema === 2) {
    const run = raw.run;
    v2Valid =
      isRecord(run) &&
      typeof run.run_id === "string" &&
      typeof run.created_at === "string" &&
      typeof run.task === "string" &&
      typeof run.model_id === "string" &&
      (run.model_provider === undefined ||
        ["anthropic", "openai", "google"].includes(run.model_provider)) &&
      (run.provider_model_id === undefined || typeof run.provider_model_id === "string") &&
      ((run.provider_base_url === undefined && run.provider_api_key_env === undefined) ||
        (typeof run.provider_base_url === "string" &&
          run.provider_base_url.length > 0 &&
          typeof run.provider_api_key_env === "string" &&
          run.provider_api_key_env.length > 0)) &&
      (run.reasoning_effort === undefined ||
        ["low", "medium", "high", "xhigh"].includes(run.reasoning_effort)) &&
      validBudgets(run.budgets) &&
      validBudgets(run.segment_budgets) &&
      Number.isFinite(run.wall_clock_s) &&
      run.wall_clock_s >= 0 &&
      Number.isInteger(run.resume_count) &&
      run.resume_count >= 0;
  }
  if (!coreValid || !v2Valid) {
    throw new Error(
      `${RESUME_STATE_FILE} in ${displayDir} is malformed or not a resumable checkpoint ` +
        `(expected schema 1/2 with a non-empty history at a durable tool boundary)`,
    );
  }
  return raw as ResumeStateFile;
}

function statsFromResult(result: RunResultJson): AgentStats {
  return {
    turns: result.agent.turns,
    inputTokens: result.agent.tokens_in,
    cachedInputTokens: result.agent.tokens_in_cached,
    outputTokens: result.agent.tokens_out,
    costUsd: result.agent.cost_usd,
    toolCalls: { ...result.agent.tool_calls },
    subagentsSpawned: result.agent.subagents_spawned,
    imagesSent: result.agent.images_sent,
    budgetExhausted: null,
    servedModels: [...(result.model.served_model_ids ?? [])],
  };
}

function validResultForResume(value: unknown): value is RunResultJson {
  if (!isRecord(value) || value.schema !== 1) return false;
  const model = value.model;
  const agent = value.agent;
  if (
    typeof value.run_id !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.task !== "string" ||
    !validBudgets(value.budgets) ||
    !Number.isFinite(value.wall_clock_s) ||
    value.wall_clock_s < 0 ||
    !isRecord(model) ||
    typeof model.id !== "string" ||
    !["anthropic", "openai", "google"].includes(model.provider) ||
    typeof model.provider_model_id !== "string" ||
    (model.reasoning_effort !== undefined &&
      !["low", "medium", "high", "xhigh"].includes(model.reasoning_effort)) ||
    (model.served_model_ids !== undefined &&
      (!Array.isArray(model.served_model_ids) ||
        !model.served_model_ids.every((id: unknown) => typeof id === "string"))) ||
    !isRecord(agent) ||
    typeof agent.final_text !== "string" ||
    (agent.root_turns !== undefined &&
      (!Number.isInteger(agent.root_turns) || agent.root_turns < 0)) ||
    (agent.direct_children !== undefined &&
      (!Number.isInteger(agent.direct_children) || agent.direct_children < 0))
  ) {
    return false;
  }
  const statsValid = validStats({
    turns: agent.turns,
    inputTokens: agent.tokens_in,
    cachedInputTokens: agent.tokens_in_cached,
    outputTokens: agent.tokens_out,
    costUsd: agent.cost_usd,
    toolCalls: agent.tool_calls,
    subagentsSpawned: agent.subagents_spawned,
    imagesSent: agent.images_sent,
    budgetExhausted: null,
    servedModels: model.served_model_ids ?? [],
  });
  if (!statsValid) return false;
  if (value.resumed === undefined) return true;
  const resumed = value.resumed;
  return (
    isRecord(resumed) &&
    Number.isInteger(resumed.count) &&
    resumed.count >= 1 &&
    Number.isFinite(resumed.last_added_usd) &&
    resumed.last_added_usd > 0 &&
    Number.isFinite(resumed.prior_cost_usd) &&
    resumed.prior_cost_usd >= 0 &&
    [resumed.last_added_wall_mins, resumed.last_added_turns, resumed.last_added_tokens].every(
      (cap) => cap === undefined || (Number.isFinite(cap) && cap > 0),
    )
  );
}

/** Stable defaults for a fresh resume segment, never cumulative caps. */
export function resumeBudgetDefaults(
  prior: Pick<RunResultJson, "budgets" | "resumed">,
): RunResultJson["budgets"] {
  if (!prior.resumed) return { ...prior.budgets };
  const segmentCount = prior.resumed.count + 1;
  return {
    max_usd: prior.resumed.last_added_usd,
    max_wall_mins:
      prior.resumed.last_added_wall_mins ?? prior.budgets.max_wall_mins / segmentCount,
    max_turns:
      prior.resumed.last_added_turns ??
      Math.max(1, Math.floor(prior.budgets.max_turns / segmentCount)),
    max_tokens:
      prior.resumed.last_added_tokens ??
      Math.max(1, Math.floor(prior.budgets.max_tokens / segmentCount)),
  };
}

interface ResumeBaseline {
  runId: string;
  createdAt: string;
  task: string;
  modelId: string;
  modelProvider?: ModelEntry["provider"];
  providerModelId?: string;
  reasoningEffort?: string;
  budgets: RunResultJson["budgets"];
  segmentBudgets: RunResultJson["budgets"];
  wallClockS: number;
  resumeCount: number;
  stats: AgentStats;
  finalText: string;
  rootTurns?: number;
  directChildren?: number;
}

function baselineFromResult(result: RunResultJson): ResumeBaseline {
  return {
    runId: result.run_id,
    createdAt: result.created_at,
    task: result.task,
    modelId: result.model.id,
    modelProvider: result.model.provider as ModelEntry["provider"],
    providerModelId: result.model.provider_model_id,
    reasoningEffort: result.model.reasoning_effort,
    budgets: { ...result.budgets },
    segmentBudgets: resumeBudgetDefaults(result),
    wallClockS: result.wall_clock_s,
    resumeCount: result.resumed?.count ?? 0,
    stats: statsFromResult(result),
    finalText: result.agent.final_text,
    rootTurns: result.agent.root_turns,
    directChildren: result.agent.direct_children,
  };
}

function baselineFromCheckpoint(state: ResumeStateFileV2): ResumeBaseline {
  return {
    runId: state.run.run_id,
    createdAt: state.run.created_at,
    task: state.run.task,
    modelId: state.run.model_id,
    modelProvider: state.run.model_provider,
    providerModelId: state.run.provider_model_id,
    reasoningEffort: state.run.reasoning_effort,
    budgets: { ...state.run.budgets },
    segmentBudgets: { ...state.run.segment_budgets },
    wallClockS: state.run.wall_clock_s,
    resumeCount: state.run.resume_count,
    stats: {
      ...state.stats,
      budgetExhausted: null,
      toolCalls: { ...state.stats.toolCalls },
      servedModels: [...state.stats.servedModels],
    },
    finalText: state.finalText,
    rootTurns: state.ownTurns,
    directChildren: state.directChildren,
  };
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
  setReasoningEffort(model, opts.effort);
  const route = providerRouteOf(model);
  const provider = providerFor(model, route);
  const brief = readTaskBrief(opts.task);

  const runsRoot = opts.runsDir ?? path.join(packageRoot(), "runs");
  const runId = runIdFor(opts.task, model.id);
  const runDir = path.join(runsRoot, runId);
  const workspace = path.join(runDir, "workspace");
  fs.mkdirSync(runsRoot, { recursive: true });
  try {
    fs.mkdirSync(runDir);
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      throw new Error(`run directory already exists: ${runDir}; wait a second and retry`);
    }
    throw e;
  }
  const releaseLock = acquireRunLock(runDir);
  try {
    seedWorkspace(workspace, opts.task);

    const budget = new BudgetTracker({
      maxUsd: opts.maxUsd ?? DEFAULT_LIMITS.maxUsd,
      maxWallMs: (opts.maxWallMins ?? DEFAULT_LIMITS.maxWallMs / 60_000) * 60_000,
      maxTurns: opts.maxTurns ?? DEFAULT_LIMITS.maxTurns,
      maxTokens: opts.maxTokens ?? DEFAULT_LIMITS.maxTokens,
    });
    const runBudgets: RunResultJson["budgets"] = {
      max_usd: budget.limits.maxUsd,
      max_wall_mins: Math.round(budget.limits.maxWallMs / 60_000),
      max_turns: budget.limits.maxTurns,
      max_tokens: budget.limits.maxTokens,
    };
    const transcript = new Transcript(path.join(runDir, "transcript.jsonl"), opts.quiet ?? false);
    const started = Date.now();
    const createdAt = new Date(started).toISOString();

    console.log(`run ${runId}`);
    console.log(
      `  task: ${opts.task}  model: ${model.id} (${model.provider_model_id})${model.reasoning_effort ? `  effort: ${model.reasoning_effort}` : ""}  vision: ${model.vision ? "on" : "off"}`,
    );
    console.log(
      `  budget: $${budget.limits.maxUsd}, ${Math.round(budget.limits.maxWallMs / 60_000)} min, ${budget.limits.maxTurns} turns, ${budget.limits.maxTokens} tokens`,
    );
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
    let runtimeState: AgentRuntimeState = { ownTurns: 0, directChildren: 0, tasks: [] };
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
        onCheckpoint: (cp) =>
          writeCheckpoint(runDir, cp, {
            run_id: runId,
            created_at: createdAt,
            task: opts.task,
            model_id: model.id,
            model_provider: model.provider,
            provider_model_id: model.provider_model_id,
            provider_base_url: route.baseUrl,
            provider_api_key_env: route.apiKeyEnv,
            ...(model.reasoning_effort ? { reasoning_effort: model.reasoning_effort } : {}),
            budgets: runBudgets,
            segment_budgets: runBudgets,
            wall_clock_s: Math.round((Date.now() - started) / 1000),
            resume_count: 0,
          }),
      });
      const result = await agent.run(
        `Build the game described in the task brief below. The brief is also available at TASK.md in your workspace.\n\n${brief}`,
      );
      stats = result.stats;
      finalText = result.finalText;
      runtimeState = agent.snapshotRuntimeState();
    } catch (e: any) {
      agentError = e?.message ?? String(e);
      transcript.log("error", "runner", 0, { message: agentError ?? "unknown" });
      // Keep partial accounting/runtime state so an abort doesn't erase prior work.
      if (agent) {
        stats = agent.snapshotStats();
        runtimeState = agent.snapshotRuntimeState();
      }
    }
    transcript.close();

    return await finalizeRun({
      runDir,
      runId,
      createdAt,
      startedMs: started,
      priorWallS: 0,
      task: opts.task,
      model,
      budget,
      budgets: runBudgets,
      stats,
      runtimeState,
      finalText,
      agentError,
    });
  } finally {
    releaseLock();
  }
}

interface FinalizeParams {
  runDir: string;
  runId: string;
  createdAt: string;
  /** Wall-clock start of this segment. */
  startedMs: number;
  /** Wall seconds from prior segments (0 for a fresh run). */
  priorWallS: number;
  task: string;
  model: ModelEntry;
  budget: BudgetTracker;
  budgets: RunResultJson["budgets"];
  stats: AgentStats;
  runtimeState: AgentRuntimeState;
  finalText: string;
  agentError: string | null;
  resumed?: RunResultJson["resumed"];
}

/** Settle accounting, score gates, write result.json, print the summary. */
async function finalizeRun(p: FinalizeParams): Promise<{ runDir: string; result: RunResultJson }> {
  const { runDir, model, stats } = p;
  const workspace = path.join(runDir, "workspace");
  // Budget tracker includes concurrent subagents — prefer it on abort. On a
  // resume, stats.costUsd already carries prior spend and outweighs the segment
  // tracker, so cumulative cost survives.
  stats.costUsd = Math.max(stats.costUsd, p.budget.usedUsd);
  const wallClockS = p.priorWallS + Math.round((Date.now() - p.startedMs) / 1000);

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
    run_id: p.runId,
    created_at: p.createdAt,
    task: p.task,
    model: resultModelMetadata(model, stats.servedModels),
    budgets: p.budgets,
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
      error: p.agentError,
      final_text: p.finalText,
      root_turns: p.runtimeState.ownTurns,
      direct_children: p.runtimeState.directChildren,
    },
    code: codeStats(workspace),
    gates,
    gate_error: gateError,
    screenshots: listScreenshots(runDir),
    ...(p.resumed ? { resumed: p.resumed } : {}),
  };
  writeJsonAtomic(path.join(runDir, "result.json"), result);

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

export interface ResumeOptions {
  /** Path to an existing runs/<id> directory. */
  runDir: string;
  /** Fresh budget window for the resumed segment; each defaults to the prior segment's cap. */
  maxUsd?: number;
  maxWallMins?: number;
  maxTurns?: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh";
  quiet?: boolean;
}

/**
 * Continue a run that stopped early (budget exhausted or a provider crash),
 * reusing its workspace and conversation. The resumed segment gets a fresh
 * budget window; result.json totals become cumulative across all segments.
 */
export async function resumeBench(
  opts: ResumeOptions,
): Promise<{ runDir: string; result: RunResultJson }> {
  const runDir = path.resolve(opts.runDir);
  const resultFile = path.join(runDir, "result.json");
  const stateFile = path.join(runDir, RESUME_STATE_FILE);
  const workspace = path.join(runDir, "workspace");
  if (!fs.existsSync(workspace)) {
    throw new Error(`no workspace/ in ${opts.runDir} — nothing to resume`);
  }
  if (!fs.existsSync(stateFile)) {
    throw new Error(
      `no ${RESUME_STATE_FILE} in ${opts.runDir} — this run predates resume support ` +
        `or stopped before its first tool-call response, so there is no checkpoint to continue from`,
    );
  }
  const releaseLock = acquireRunLock(runDir);
  try {
    const state = readResumeState(stateFile, opts.runDir);
    let priorResult: RunResultJson | null = null;
    if (fs.existsSync(resultFile)) {
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      } catch (e: any) {
        if (state.schema === 1) {
          throw new Error(`result.json in ${opts.runDir} is not valid JSON: ${e?.message ?? e}`);
        }
        console.warn(
          `warning: ignoring unreadable result.json in ${opts.runDir}; recovering from ${RESUME_STATE_FILE}`,
        );
      }
      if (parsed !== undefined) {
        if (validResultForResume(parsed)) {
          priorResult = parsed;
        } else if (state.schema === 1) {
          throw new Error(`result.json in ${opts.runDir} is malformed and cannot seed a resume`);
        } else {
          console.warn(
            `warning: ignoring malformed result.json in ${opts.runDir}; recovering from ${RESUME_STATE_FILE}`,
          );
        }
      }
    }
    if (state.schema === 1 && !priorResult) {
      throw new Error(
        `${RESUME_STATE_FILE} in ${opts.runDir} uses legacy schema 1 and needs its matching result.json; ` +
          `new schema 2 checkpoints are self-describing and recover without it`,
      );
    }
    if (
      state.schema === 2 &&
      priorResult &&
      (state.run.run_id !== priorResult.run_id ||
        state.run.task !== priorResult.task ||
        state.run.model_id !== priorResult.model.id ||
        (state.run.model_provider !== undefined &&
          state.run.model_provider !== priorResult.model.provider) ||
        (state.run.provider_model_id !== undefined &&
          state.run.provider_model_id !== priorResult.model.provider_model_id))
    ) {
      throw new Error(
        `${RESUME_STATE_FILE} and result.json in ${opts.runDir} describe different runs`,
      );
    }

    const resultResumeCount = priorResult?.resumed?.count ?? 0;
    // A checkpoint from a segment that has not finalized yet is newer than the
    // old result.json. Otherwise result.json includes later wrap-up accounting.
    const checkpointIsNewer =
      state.schema === 2 && (!priorResult || state.run.resume_count > resultResumeCount);
    const prior = checkpointIsNewer
      ? baselineFromCheckpoint(state as ResumeStateFileV2)
      : baselineFromResult(priorResult as RunResultJson);

    const pinnedProvider = prior.modelProvider ?? priorResult?.model.provider;
    const pinnedProviderModelId = prior.providerModelId ?? priorResult?.model.provider_model_id;
    const model: ModelEntry = getModel(prior.modelId);
    const route = providerRouteOf(model);
    if (pinnedProvider && pinnedProviderModelId) {
      if (model.provider !== pinnedProvider || model.provider_model_id !== pinnedProviderModelId) {
        throw new Error(
          `model registry entry "${prior.modelId}" changed since this run ` +
            `(checkpoint: ${pinnedProvider}/${pinnedProviderModelId}; ` +
            `current: ${model.provider}/${model.provider_model_id}); refusing an unsafe resume`,
        );
      }
    } else {
      console.warn(
        `warning: ${RESUME_STATE_FILE} predates pinned provider identity; ` +
          `resuming with current mapping ${model.provider}/${model.provider_model_id}`,
      );
    }
    const pinnedBaseUrl = state.schema === 2 ? state.run.provider_base_url : undefined;
    const pinnedApiKeyEnv = state.schema === 2 ? state.run.provider_api_key_env : undefined;
    if (pinnedBaseUrl && pinnedApiKeyEnv) {
      if (route.baseUrl !== pinnedBaseUrl || route.apiKeyEnv !== pinnedApiKeyEnv) {
        throw new Error(
          `model registry route "${prior.modelId}" changed since this run ` +
            `(checkpoint: ${pinnedBaseUrl} via ${pinnedApiKeyEnv}; ` +
            `current: ${route.baseUrl} via ${route.apiKeyEnv}); refusing an unsafe resume`,
        );
      }
    } else {
      console.warn(
        `warning: ${RESUME_STATE_FILE} predates pinned endpoint identity; ` +
          `resuming with current route ${route.baseUrl} via ${route.apiKeyEnv}`,
      );
    }
    const priorEffort = prior.reasoningEffort as ModelEntry["reasoning_effort"];
    setReasoningEffort(model, opts.effort ?? priorEffort);
    const provider = providerFor(model, route);

    const budget = new BudgetTracker({
      maxUsd: opts.maxUsd ?? prior.segmentBudgets.max_usd,
      maxWallMs: (opts.maxWallMins ?? prior.segmentBudgets.max_wall_mins) * 60_000,
      maxTurns: opts.maxTurns ?? prior.segmentBudgets.max_turns,
      maxTokens: opts.maxTokens ?? prior.segmentBudgets.max_tokens,
    });
    const segmentBudgets: RunResultJson["budgets"] = {
      max_usd: budget.limits.maxUsd,
      max_wall_mins: Math.round(budget.limits.maxWallMs / 60_000),
      max_turns: budget.limits.maxTurns,
      max_tokens: budget.limits.maxTokens,
    };
    const cumulativeBudgets: RunResultJson["budgets"] = {
      max_usd: Number((prior.budgets.max_usd + segmentBudgets.max_usd).toFixed(6)),
      max_wall_mins: prior.budgets.max_wall_mins + segmentBudgets.max_wall_mins,
      max_turns: prior.budgets.max_turns + segmentBudgets.max_turns,
      max_tokens: prior.budgets.max_tokens + segmentBudgets.max_tokens,
    };
    const resumeCount = prior.resumeCount + 1;
    const transcript = new Transcript(path.join(runDir, "transcript.jsonl"), opts.quiet ?? false);

    console.log(`resume ${prior.runId}`);
    console.log(
      `  task: ${prior.task}  model: ${model.id} (${model.provider_model_id})${model.reasoning_effort ? `  effort: ${model.reasoning_effort}` : ""}`,
    );
    console.log(`  prior: $${prior.stats.costUsd.toFixed(2)} spent, ${prior.stats.turns} turns`);
    console.log(
      `  fresh budget: $${budget.limits.maxUsd}, ${Math.round(budget.limits.maxWallMs / 60_000)} min, ${budget.limits.maxTurns} turns`,
    );
    transcript.log("resume", "runner", 0, {
      priorCostUsd: prior.stats.costUsd,
      priorTurns: prior.stats.turns,
      addedBudgetUsd: budget.limits.maxUsd,
      resumeCount,
      recoveredFromCheckpoint: checkpointIsNewer,
    });

    const priorStats: AgentStats = {
      ...prior.stats,
      budgetExhausted: null,
      toolCalls: { ...prior.stats.toolCalls },
      servedModels: [...prior.stats.servedModels],
    };
    const resumeState: AgentCheckpoint = {
      messages: state.messages,
      // result.json may include a later wrap-up summary; the checkpoint carries
      // the clean conversation boundary to continue from.
      finalText: prior.finalText || state.finalText,
      stats: priorStats,
      ownTurns: prior.rootTurns ?? state.ownTurns,
      directChildren:
        prior.directChildren ?? state.directChildren ?? prior.stats.subagentsSpawned,
      tasks: structuredClone(state.tasks ?? []),
      ...(state.inFlightToolCalls
        ? { inFlightToolCalls: structuredClone(state.inFlightToolCalls) }
        : {}),
    };

    const started = Date.now();
    let stats: AgentStats = priorStats;
    let runtimeState: AgentRuntimeState = {
      ownTurns: resumeState.ownTurns,
      directChildren: resumeState.directChildren,
      tasks: structuredClone(resumeState.tasks),
    };
    let finalText = resumeState.finalText;
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
        resumeState,
        onCheckpoint: (cp) =>
          writeCheckpoint(runDir, cp, {
            run_id: prior.runId,
            created_at: prior.createdAt,
            task: prior.task,
            model_id: model.id,
            model_provider: model.provider,
            provider_model_id: model.provider_model_id,
            provider_base_url: route.baseUrl,
            provider_api_key_env: route.apiKeyEnv,
            ...(model.reasoning_effort ? { reasoning_effort: model.reasoning_effort } : {}),
            budgets: cumulativeBudgets,
            segment_budgets: segmentBudgets,
            wall_clock_s: prior.wallClockS + Math.round((Date.now() - started) / 1000),
            resume_count: resumeCount,
          }),
      });
      // initialUserMessage is ignored when resuming from a checkpoint.
      const result = await agent.run("");
      stats = result.stats;
      finalText = result.finalText;
      runtimeState = agent.snapshotRuntimeState();
    } catch (e: any) {
      agentError = e?.message ?? String(e);
      transcript.log("error", "runner", 0, { message: agentError ?? "unknown" });
      if (agent) {
        stats = agent.snapshotStats();
        runtimeState = agent.snapshotRuntimeState();
      }
    }
    transcript.close();

    return await finalizeRun({
      runDir,
      runId: prior.runId,
      createdAt: prior.createdAt,
      startedMs: started,
      priorWallS: prior.wallClockS,
      task: prior.task,
      model,
      budget,
      budgets: cumulativeBudgets,
      stats,
      runtimeState,
      finalText,
      agentError,
      resumed: {
        count: resumeCount,
        last_added_usd: segmentBudgets.max_usd,
        last_added_wall_mins: segmentBudgets.max_wall_mins,
        last_added_turns: segmentBudgets.max_turns,
        last_added_tokens: segmentBudgets.max_tokens,
        prior_cost_usd: prior.stats.costUsd,
      },
    });
  } finally {
    releaseLock();
  }
}
