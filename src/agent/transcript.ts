import fs from "node:fs";
import path from "node:path";

/**
 * JSONL transcript: one line per event (request, response, tool_call,
 * tool_result, budget, warn, error), plus a human-readable console mirror.
 */
export interface TranscriptEvent {
  ts: string;
  type: string;
  depth: number;
  agent: string;
  [key: string]: unknown;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export class Transcript {
  private stream: fs.WriteStream | null = null;

  constructor(
    file: string | null,
    private quiet = false,
  ) {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: "a" });
    }
  }

  log(type: string, agent: string, depth: number, data: Record<string, unknown>): void {
    const event: TranscriptEvent = {
      ts: new Date().toISOString(),
      type,
      depth,
      agent,
      ...data,
    };
    this.stream?.write(JSON.stringify(event) + "\n");
    if (!this.quiet) this.print(event);
  }

  private print(e: TranscriptEvent): void {
    const pad = "  ".repeat(e.depth);
    const tag = e.depth > 0 ? `${e.agent}` : e.agent;
    switch (e.type) {
      case "request":
        console.log(pad + dim(`[${tag}] turn ${e.turn} → ${e.model}`));
        break;
      case "response": {
        const text = typeof e.text === "string" ? e.text : "";
        const calls = Array.isArray(e.toolCalls) ? (e.toolCalls as string[]) : [];
        if (text.trim()) console.log(pad + bold(`[${tag}] `) + text.trim().slice(0, 1500));
        if (calls.length > 0) console.log(pad + cyan(`[${tag}] tools: ${calls.join(", ")}`));
        console.log(
          pad +
            dim(
              `[${tag}] tokens in=${e.inputTokens} out=${e.outputTokens} cost=$${Number(e.costUsd ?? 0).toFixed(4)} total=$${Number(e.totalUsd ?? 0).toFixed(4)}`,
            ),
        );
        break;
      }
      case "tool_call":
        console.log(pad + cyan(`[${tag}] ▸ ${e.tool} `) + dim(String(e.summary ?? "")));
        break;
      case "tool_result": {
        const out = String(e.output ?? "");
        const head = out.length > 300 ? out.slice(0, 300) + "…" : out;
        const paint = e.isError ? red : dim;
        console.log(pad + paint(`[${tag}] ◂ ${e.tool}: ${head.replace(/\n/g, " ⏎ ")}`));
        break;
      }
      case "budget":
        console.log(pad + yellow(`[${tag}] budget: ${e.reason}`));
        break;
      case "error":
        console.log(pad + red(`[${tag}] error: ${e.message}`));
        break;
      default:
        console.log(pad + dim(`[${tag}] ${e.type}: ${JSON.stringify({ ...e, ts: undefined, type: undefined, depth: undefined, agent: undefined })}`));
    }
  }

  close(): void {
    this.stream?.end();
  }
}
