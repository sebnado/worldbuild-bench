import { z } from "zod";
import { Tool, ToolContext } from "./index.js";

export const MAX_SPAWN_DEPTH = 2;

/**
 * Delegate a task to a subagent: fresh context, same tools and workspace,
 * drawing on the same shared run budget. Returns the child's final text.
 * The agent loop runs multiple spawn_agent calls from one assistant turn
 * concurrently. Depth is capped at MAX_SPAWN_DEPTH.
 */
export const spawnAgentTool: Tool = {
  def: {
    name: "spawn_agent",
    description:
      "Spawn a focused subagent with a fresh context to work on one well-scoped task in the same workspace. It has the same tools and returns its final summary text. Give complete, self-contained instructions: exact files to create, exports/interfaces to expose, and any contracts it must follow. Issue several spawn_agent calls in one reply to run them in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Complete self-contained instructions for the subagent (context, file boundaries, interfaces, style constraints)",
        },
      },
      required: ["task"],
    },
  },
  schema: z.object({
    task: z.string().min(1),
  }),
  async execute(input, ctx: ToolContext): Promise<string> {
    if (!ctx.spawn) return "spawn_agent is not available in this context";
    if (ctx.depth >= MAX_SPAWN_DEPTH) {
      return `spawn_agent rejected: maximum subagent depth (${MAX_SPAWN_DEPTH}) reached — do the work directly`;
    }
    return ctx.spawn(input.task);
  },
};
