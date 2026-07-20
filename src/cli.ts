#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runBench, resumeBench, listTasks, readTaskBrief, gateResultToJson } from "./bench/run.js";
import { runGates } from "./bench/gates.js";
import { writeRound, modelRows } from "./bench/report.js";
import { packageRoot } from "./util/paths.js";

/**
 * Minimal .env loader (no deps): first .env found in [cwd, package root]
 * wins; real environment variables always take precedence over the file.
 */
function loadDotEnv(): void {
  const dirs = [process.cwd(), packageRoot()];
  for (const dir of dirs) {
    const file = path.join(dir, ".env");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      const [, key, raw] = m;
      if (process.env[key] !== undefined) continue;
      let value = raw.trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return;
  }
}

const HELP = `worldbuild-bench — a neutral harness for benchmarking AI-built 3D games

Usage: wb <command> [options]

Commands:
  run --task <slug> --model <id>   Run one benchmark: seed a workspace, let the
                                   model build the game, then score it.
      [--budget-usd <n>]           Cost backstop in USD (default 100). Runs
                                   end at the model's natural completion;
                                   all caps are pathology backstops, not
                                   budgets — tighten this one for debugging
      [--budget-mins <n>]          Wall-clock backstop in minutes (default 360)
      [--max-turns <n>]            Agent-tree turn backstop (default 10000)
      [--max-tokens <n>]           Token backstop (default effectively
                                   unlimited — cost already prices tokens)
      [--effort <tier>]            Reasoning effort low|medium|high|xhigh, sent
                                   via each provider's native control
                                   (default: provider default)
      [--quiet]                    Suppress per-turn console output

  resume <run-dir>                 Continue a run after budget exhaustion,
                                   interruption, or a provider/process crash
                                   after its first tool-call response. Reuses
                                   the workspace and conversation. Each cap
                                   defaults to the previous segment's cap;
                                   result.json totals remain cumulative.
      [--budget-usd <n>]           Fresh cost window for this segment
      [--budget-mins <n>]          Fresh wall-clock window for this segment
      [--max-turns <n>] [--max-tokens <n>] [--effort <tier>] [--quiet]
                                   Registry entries may map effort tiers
                                   (Kimi K3: every tier maps to native "max")

  gate <dir> [--page <file>]       Score an existing game directory (or a
                                   runs/<id> directory containing workspace/).
                                   Prints the gate checklist and both scores.

  report --round <slug> [dirs...]  Merge run results into a round JSON
      [--title <t>] [--date <d>]   (site schema v2). Defaults to every run
      [--out <file>]               under runs/ when no dirs are given.
      [--allow-mixed-budgets]      Merge runs with differing budgets (throws
                                   otherwise); per-result budgets are then
                                   included in the JSON.

  models                           List the model registry (models.json).
  tasks                            List available task briefs.
  help                             Show this help.

Environment:
  Provider API keys are read from the environment; a .env file (cwd or the
  package root) is loaded automatically — see .env.example.
  Populate the Three.js scaffold first: npm run fetch-three

Examples:
  wb run --task racing --model claude-sonnet-5 --budget-usd 5 --budget-mins 20
  wb resume runs/20260703-120000-racing-claude-sonnet-5 --budget-usd 5
  wb gate runs/20260703-120000-racing-claude-sonnet-5
  wb report --round july-2026
`;

interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function requireStr(flags: Parsed["flags"], name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required option --${name} (see wb help)`);
  }
  return v;
}

function optNum(flags: Parsed["flags"], name: string): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

function printTable(rows: Array<Record<string, string>>): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => r[c] ?? "")));
}

async function cmdRun(p: Parsed): Promise<void> {
  const effort = typeof p.flags.effort === "string" ? p.flags.effort : undefined;
  if (effort && !["low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error(`--effort must be one of low|medium|high|xhigh (got "${effort}")`);
  }
  await runBench({
    task: requireStr(p.flags, "task"),
    model: requireStr(p.flags, "model"),
    maxUsd: optNum(p.flags, "budget-usd"),
    maxWallMins: optNum(p.flags, "budget-mins"),
    maxTurns: optNum(p.flags, "max-turns"),
    maxTokens: optNum(p.flags, "max-tokens"),
    effort: effort as "low" | "medium" | "high" | "xhigh" | undefined,
    quiet: p.flags.quiet === true,
  });
}

async function cmdResume(p: Parsed): Promise<void> {
  const runDir = p.positional[0];
  if (!runDir) throw new Error("usage: wb resume <run-dir> (a runs/<id> directory)");
  const effort = typeof p.flags.effort === "string" ? p.flags.effort : undefined;
  if (effort && !["low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error(`--effort must be one of low|medium|high|xhigh (got "${effort}")`);
  }
  await resumeBench({
    runDir,
    maxUsd: optNum(p.flags, "budget-usd"),
    maxWallMins: optNum(p.flags, "budget-mins"),
    maxTurns: optNum(p.flags, "max-turns"),
    maxTokens: optNum(p.flags, "max-tokens"),
    effort: effort as "low" | "medium" | "high" | "xhigh" | undefined,
    quiet: p.flags.quiet === true,
  });
}

async function cmdGate(p: Parsed): Promise<void> {
  const target = p.positional[0];
  if (!target) throw new Error("usage: wb gate <dir> — a game directory or a runs/<id> directory");
  const dir = path.resolve(target);
  if (!fs.existsSync(dir)) throw new Error(`directory not found: ${target}`);
  const isRunDir = fs.existsSync(path.join(dir, "workspace"));
  const workspace = isRunDir ? path.join(dir, "workspace") : dir;
  const screenshotDir = isRunDir ? path.join(dir, "screenshots") : path.join(dir, ".playtest");
  const page = typeof p.flags.page === "string" ? p.flags.page : undefined;

  const g = await runGates(workspace, { screenshotDir, page });
  const rows = [...g.gates, ...g.coherenceGates.map((c) => ({ ...c, id: `wc_${c.id}` }))].map(
    (item) => ({
      gate: item.id,
      weight: String(item.weight),
      pass: item.pass ? "PASS" : "fail",
      detail: item.detail.slice(0, 80),
    }),
  );
  printTable(rows);
  console.log(`\nPlayability Score:     ${g.playability}/100${g.capped ? " (capped: window.__bench missing)" : ""}`);
  console.log(`World Coherence Score: ${g.worldCoherence}/100`);
  console.log(`screenshots: ${screenshotDir}`);

  // Refresh result.json when gating a run directory.
  const resultFile = path.join(dir, "result.json");
  if (isRunDir && fs.existsSync(resultFile)) {
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    result.gates = gateResultToJson(g);
    result.gate_error = null;
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n");
    console.log(`updated ${resultFile}`);
  }
}

function cmdReport(p: Parsed): void {
  const out = writeRound({
    round: requireStr(p.flags, "round"),
    title: typeof p.flags.title === "string" ? p.flags.title : undefined,
    date: typeof p.flags.date === "string" ? p.flags.date : undefined,
    out: typeof p.flags.out === "string" ? p.flags.out : undefined,
    runDirs: p.positional.length > 0 ? p.positional.map((d) => path.resolve(d)) : undefined,
    allowMixedBudgets: p.flags["allow-mixed-budgets"] === true,
  });
  console.log(`round JSON written: ${out}`);
}

function cmdModels(): void {
  printTable(modelRows());
}

function cmdTasks(): void {
  const tasks = listTasks();
  if (tasks.length === 0) {
    console.log(`no tasks found under ${path.join(packageRoot(), "tasks")}`);
    return;
  }
  for (const t of tasks) {
    const firstLine = readTaskBrief(t).split("\n").find((l) => l.trim().startsWith("#"));
    console.log(`${t.padEnd(18)} ${firstLine ? firstLine.replace(/^#+\s*/, "") : ""}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const p = parseArgv(process.argv.slice(2));
  switch (p.command) {
    case "run":
      await cmdRun(p);
      break;
    case "resume":
      await cmdResume(p);
      break;
    case "gate":
      await cmdGate(p);
      break;
    case "report":
      cmdReport(p);
      break;
    case "models":
      cmdModels();
      break;
    case "tasks":
      cmdTasks();
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${p.command}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`error: ${e?.message ?? e}`);
  process.exitCode = 1;
});
