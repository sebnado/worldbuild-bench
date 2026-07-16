import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Tool, ToolContext, truncate } from "./index.js";
import { resolveInside } from "../util/paths.js";

const READ_CAP = 60_000;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** Directory subtrees collapsed in listings (bundled libraries). */
const COLLAPSE_DIRS = new Set(["lib"]);

export const readFileTool: Tool = {
  def: {
    name: "read_file",
    description:
      "Read a file from the workspace. Path is workspace-relative. Optionally pass offset/limit (line numbers) for large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        offset: { type: "number", description: "1-based first line to read" },
        limit: { type: "number", description: "Max number of lines to return" },
      },
      required: ["path"],
    },
  },
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional(),
  }),
  async execute(input, ctx: ToolContext): Promise<string> {
    const abs = resolveInside(ctx.workspace, input.path);
    if (!fs.existsSync(abs)) return `file not found: ${input.path}`;
    if (fs.statSync(abs).isDirectory()) return `${input.path} is a directory — use list_files`;
    let text = fs.readFileSync(abs, "utf8");
    if (input.offset || input.limit) {
      const lines = text.split("\n");
      const start = (input.offset ?? 1) - 1;
      const end = input.limit ? start + input.limit : lines.length;
      text = lines.slice(start, end).join("\n");
    }
    return truncate(text, READ_CAP, input.path);
  },
};

export const writeFileTool: Tool = {
  def: {
    name: "write_file",
    description:
      "Write a file in the workspace (creates parent directories, overwrites if it exists). Pass append: true to append to the end of the file instead — use several append calls to build a file too large for a single reply. Path is workspace-relative.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        content: { type: "string", description: "Full file content (or the next chunk when append is true)" },
        append: { type: "boolean", description: "Append to the file instead of overwriting (default false)" },
      },
      required: ["path", "content"],
    },
  },
  schema: z.object({ path: z.string().min(1), content: z.string(), append: z.boolean().optional() }),
  async execute(input, ctx: ToolContext): Promise<string> {
    const abs = resolveInside(ctx.workspace, input.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (input.append) {
      fs.appendFileSync(abs, input.content);
      return `appended ${Buffer.byteLength(input.content)} bytes to ${input.path} (now ${fs.statSync(abs).size} bytes)`;
    }
    fs.writeFileSync(abs, input.content);
    return `wrote ${input.path} (${Buffer.byteLength(input.content)} bytes)`;
  },
};

export const editFileTool: Tool = {
  def: {
    name: "edit_file",
    description:
      "Edit a file by exact string replacement. old_string must appear exactly once in the file (or pass replace_all: true to replace every occurrence).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  schema: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  async execute(input, ctx: ToolContext): Promise<string> {
    const abs = resolveInside(ctx.workspace, input.path);
    if (!fs.existsSync(abs)) return `file not found: ${input.path}`;
    const text = fs.readFileSync(abs, "utf8");
    const count = text.split(input.old_string).length - 1;
    if (count === 0) return `old_string not found in ${input.path} — read the file and match exactly`;
    if (count > 1 && !input.replace_all) {
      return `old_string appears ${count} times in ${input.path} — provide more surrounding context or pass replace_all: true`;
    }
    const updated = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string);
    fs.writeFileSync(abs, updated);
    return `edited ${input.path} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? "s" : ""})`;
  },
};

export const listFilesTool: Tool = {
  def: {
    name: "list_files",
    description:
      "Recursively list files in the workspace (or a subdirectory). Bundled library directories (lib/) are collapsed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory (default: workspace root)" },
      },
    },
  },
  schema: z.object({ path: z.string().optional() }),
  async execute(input, ctx: ToolContext): Promise<string> {
    const root = resolveInside(ctx.workspace, input.path ?? ".");
    if (!fs.existsSync(root)) return `directory not found: ${input.path ?? "."}`;
    const lines: string[] = [];
    const walk = (dir: string, prefix: string, depth: number) => {
      if (lines.length > 500) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (lines.length > 500) {
          lines.push(`${prefix}… (listing capped at 500 entries)`);
          return;
        }
        if (SKIP_DIRS.has(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (COLLAPSE_DIRS.has(entry.name)) {
            lines.push(`${prefix}${entry.name}/ (bundled library — contents omitted)`);
            continue;
          }
          lines.push(`${prefix}${entry.name}/`);
          if (depth < 8) walk(p, prefix + "  ", depth + 1);
        } else {
          const size = fs.statSync(p).size;
          lines.push(`${prefix}${entry.name} (${size} bytes)`);
        }
      }
    };
    walk(root, "", 0);
    return lines.length > 0 ? lines.join("\n") : "(empty)";
  },
};
