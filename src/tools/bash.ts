import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Tool, ToolContext, truncate } from "./index.js";

const OUTPUT_CAP = 30_000; // 30KB
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

const InputSchema = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

/** Best-effort jail (not a sandbox) — reject `..` and abs paths outside workspace. */
export function violatesJail(command: string, workspace: string): string | null {
  if (/(^|[\s/'"=(])\.\.(\/|["'\s)]|$)/.test(command)) {
    return "command contains '..' path traversal — use workspace-relative paths";
  }
  const tokens = command.split(/[\s;|&<>()'"`]+/).filter(Boolean);
  for (const t of tokens) {
    if (!t.startsWith("/")) continue;
    // NOTE: the bare "/" token is deliberately NOT allowed — `ln -s / x`
    // would make the whole filesystem reachable through the workspace.
    if (t.startsWith(path.resolve(workspace) + "/") || t === path.resolve(workspace)) continue;
    if (t === "/dev/null" || t.startsWith("/dev/std")) continue;
    return `absolute path outside the workspace is not allowed: ${t}`;
  }
  return null;
}

const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TERM", "TZ", "NODE_ENV"] as const;

/**
 * Strip parent secrets from the child env. Only ENV_ALLOWLIST survives;
 * HOME/TMPDIR point into the workspace so `~` can't escape.
 */
export function sandboxEnv(workspace: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: workspace,
    TMPDIR: path.join(workspace, ".tmp"),
    PWD: workspace,
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
}

export const bashTool: Tool = {
  def: {
    name: "bash",
    description:
      "Run a shell command in the workspace directory. Paths must be workspace-relative; '..' and absolute paths outside the workspace are rejected. Output is capped at 30KB. Default timeout 120s (override with timeout_ms, max 300s).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run (bash -c)" },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default 120000, max 300000)",
        },
      },
      required: ["command"],
    },
  },
  schema: InputSchema,

  async execute(input: z.infer<typeof InputSchema>, ctx: ToolContext): Promise<string> {
    const violation = violatesJail(input.command, ctx.workspace);
    if (violation) return `rejected: ${violation}`;

    const timeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const env = sandboxEnv(ctx.workspace);
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", input.command], {
        cwd: ctx.workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        let result = "";
        if (out) result += out;
        if (err) result += (result ? "\n--- stderr ---\n" : "") + err;
        if (timedOut) result += `\n[command timed out after ${timeout}ms and was killed]`;
        else if (code !== 0) result += `\n[exit code ${code}]`;
        resolve(truncate(result || "(no output)", OUTPUT_CAP, "bash output"));
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(`failed to start command: ${e.message}`);
      });
    });
  },
};
