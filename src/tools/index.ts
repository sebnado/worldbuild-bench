import { z } from "zod";
import { ToolDef } from "../providers/types.js";
import { BudgetTracker } from "../agent/budget.js";
import { Transcript } from "../agent/transcript.js";

export interface ToolContext {
  /** Absolute path of the run workspace (jail root for every tool). */
  workspace: string;
  /** Subagent nesting depth of the calling agent (root = 0). */
  depth: number;
  budget: BudgetTracker;
  transcript: Transcript;
  /** Wired by the agent: runs a child agent and returns its final text. */
  spawn?: (task: string) => Promise<string>;
  /** Per-agent task list mutated by the update_tasks tool (each agent's is private). */
  tasks?: TaskStore;
}

export type TaskStatus = "pending" | "in_progress" | "done";

export interface TaskItem {
  title: string;
  status: TaskStatus;
}

/** Holder for an agent's task list; owned by the Agent, one per agent instance. */
export interface TaskStore {
  list: TaskItem[];
}

/** Image a tool attaches alongside its text output (base64, no data: prefix). */
export interface ToolImage {
  media_type: string;
  data: string;
  /** Short caption shown to the model right before the image. */
  label: string;
}

/** Rich tool output: text plus optional images (vision models only). */
export interface ToolOutput {
  text: string;
  images?: ToolImage[];
}

export interface Tool {
  def: ToolDef;
  /** Zod schema used to validate/parse raw model input before execute. */
  schema: z.ZodType<any>;
  execute(input: any, ctx: ToolContext): Promise<string | ToolOutput>;
}

export class ToolError extends Error {}

/** Validate raw input; returns a friendly error string on failure. */
export async function runTool(
  tool: Tool,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<{ output: string; images?: ToolImage[]; isError: boolean }> {
  // Adapters wrap tool-call arguments that failed JSON.parse as {__raw}.
  // The usual cause is the reply being cut off at the output-token cap
  // mid-arguments — say so, or the model retries the same oversized call.
  if (rawInput && typeof rawInput === "object" && "__raw" in (rawInput as Record<string, unknown>)) {
    return {
      output:
        `invalid input for ${tool.def.name}: the tool-call arguments were not valid JSON — ` +
        `most likely your reply hit the output-token limit and the arguments were cut off mid-stream. ` +
        `Retry with smaller arguments; build large files across several calls (write_file with append: true).`,
      isError: true,
    };
  }
  let input: any;
  try {
    input = tool.schema.parse(rawInput ?? {});
  } catch (e: any) {
    return {
      output: `invalid input for ${tool.def.name}: ${e?.message ?? String(e)}`,
      isError: true,
    };
  }
  try {
    const out = await tool.execute(input, ctx);
    if (typeof out === "string") return { output: out, isError: false };
    return {
      output: out.text,
      ...(out.images && out.images.length > 0 ? { images: out.images } : {}),
      isError: false,
    };
  } catch (e: any) {
    return { output: `${tool.def.name} failed: ${e?.message ?? String(e)}`, isError: true };
  }
}

export function truncate(text: string, max: number, label = "output"): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.8));
  const tail = text.slice(-Math.floor(max * 0.15));
  return `${head}\n… [${label} truncated: ${text.length - max} chars omitted] …\n${tail}`;
}
