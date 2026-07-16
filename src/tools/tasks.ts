import { z } from "zod";
import { TaskItem, Tool, ToolContext } from "./index.js";

/**
 * The leanest possible task tracker: one tool, one operation — replace the
 * whole list. No ids, no partial updates, no persistence machinery: the
 * re-written list re-anchors the plan in context (which is the point), the
 * transcript records every revision, and each agent's list is private
 * (subagents plan their own work without clobbering the orchestrator's).
 */
export const updateTasksTool: Tool = {
  def: {
    name: "update_tasks",
    description:
      "Replace your task list with the given items — your private plan for multi-step work. " +
      "Write the full list when you start (statuses: pending, in_progress, done), then resend " +
      "the complete updated list as items start and finish; each call replaces the previous " +
      "list entirely. Keeping the plan current is how you avoid losing the thread across a " +
      "long build: what is done, what is in flight, what remains.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "The complete task list (replaces the previous one).",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short imperative description of the task" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "Current status of this task",
              },
            },
            required: ["title", "status"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  schema: z.object({
    tasks: z
      .array(
        z.object({
          title: z.string().min(1).max(300),
          status: z.enum(["pending", "in_progress", "done"]),
        }),
      )
      .max(100),
  }),

  async execute(input: { tasks: TaskItem[] }, ctx: ToolContext): Promise<string> {
    const store = ctx.tasks ?? { list: [] };
    store.list = input.tasks;
    return renderTaskList(store.list);
  },
};

const MARKS: Record<TaskItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  done: "[x]",
};

export function renderTaskList(list: TaskItem[]): string {
  if (list.length === 0) return "Task list cleared (0 items).";
  const counts = { pending: 0, in_progress: 0, done: 0 };
  for (const t of list) counts[t.status] += 1;
  const lines = list.map((t) => `${MARKS[t.status]} ${t.title}`);
  return (
    `Task list updated (${list.length} items: ${counts.done} done, ` +
    `${counts.in_progress} in_progress, ${counts.pending} pending):\n` +
    lines.join("\n")
  );
}
