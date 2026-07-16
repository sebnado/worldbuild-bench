import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../util/paths.js";

export interface SkillIndexEntry {
  name: string;
  description: string;
  /** Workspace-relative path to the full SKILL.md. */
  path: string;
}

/**
 * Index skills copied into the workspace under skills/<name>/SKILL.md.
 * Only frontmatter name+description go into the system prompt; the agent
 * reads the full file with read_file when it needs the details.
 */
export function indexSkills(workspace: string): SkillIndexEntry[] {
  const root = path.join(workspace, "skills");
  if (!fs.existsSync(root)) return [];
  const entries: SkillIndexEntry[] = [];
  for (const dir of fs.readdirSync(root).sort()) {
    const file = path.join(root, dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    entries.push({
      name: fm.name ?? dir,
      description: fm.description ?? "",
      path: `skills/${dir}/SKILL.md`,
    });
  }
  return entries;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1].trim()] = kv[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export interface SystemPromptOpts {
  skills: SkillIndexEntry[];
  isSubagent: boolean;
  canSpawn: boolean;
}

const fragmentCache = new Map<string, string>();

/** Load a static prompt fragment from prompts/<name>.md (package root). */
function loadFragment(name: string): string {
  const cached = fragmentCache.get(name);
  if (cached !== undefined) return cached;
  const file = path.join(packageRoot(), "prompts", `${name}.md`);
  const text = fs.readFileSync(file, "utf8").replace(/\n+$/, "");
  fragmentCache.set(name, text);
  return text;
}

function formatSkills(skills: SkillIndexEntry[]): string {
  const lines = [
    "Skills — practical guides available in the workspace. Read the full file with read_file before working in that area:",
  ];
  for (const s of skills) {
    lines.push(`- ${s.name} (${s.path}): ${s.description}`);
  }
  return lines.join("\n");
}

/**
 * Neutral build system prompt — identical for every model. No provider
 * hints, no model-specific phrasing. The task brief arrives as the first
 * user message.
 *
 * Static prose lives in prompts/*.md; this function only assembles the
 * role, conditional rules, and dynamic skills index.
 */
export function buildSystemPrompt(opts: SystemPromptOpts): string {
  const rules = [loadFragment("rules-shared")];
  if (!opts.isSubagent) rules.push(loadFragment("rules-playtest"));
  if (opts.canSpawn) {
    rules.push(loadFragment(opts.isSubagent ? "rules-spawn-sub" : "rules-spawn-orch"));
  }

  const parts = [
    loadFragment(opts.isSubagent ? "subagent" : "orchestrator"),
    rules.join("\n"),
  ];
  if (opts.skills.length > 0) parts.push(formatSkills(opts.skills));
  return parts.join("\n\n");
}
