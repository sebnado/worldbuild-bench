import {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  Provider,
  ToolDef,
  ToolResultBlock,
  ToolUseBlock,
} from "../providers/types.js";
import { ModelEntry, costOf } from "../providers/index.js";
import { BudgetTracker } from "./budget.js";
import { Transcript } from "./transcript.js";
import { buildSystemPrompt, indexSkills } from "./prompts.js";
import { TaskStore, Tool, ToolContext, ToolImage, runTool } from "../tools/index.js";
import { MAX_SPAWN_DEPTH } from "../tools/spawn_agent.js";

export interface AgentOptions {
  provider: Provider;
  model: ModelEntry;
  tools: Tool[];
  workspace: string;
  budget: BudgetTracker;
  transcript: Transcript;
  depth?: number;
  label?: string;
  /** Override the built system prompt (tests). */
  systemPrompt?: string;
  maxTokensPerTurn?: number;
  temperature?: number;
}

/** Stats for an agent and its whole subagent subtree (rolls up to the root). */
export interface AgentStats {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: Record<string, number>;
  subagentsSpawned: number;
  imagesSent: number;
  budgetExhausted: string | null;
  /** Model ids the provider actually served (silent-fallback detection). */
  servedModels: string[];
}

export interface AgentResult {
  finalText: string;
  stats: AgentStats;
}

let agentCounter = 0;

/** Below this remaining wall budget, no further call is issued. */
const WALL_GRACE_MS = 5_000;
const PROVIDER_TIMEOUT_CAP_MS = 600_000;
/** Wrap-up calls reserve whatever output still fits (no 512-token floor). */
const WRAPUP_OUTPUT_FLOOR_TOKENS = 1;
/** Fallback when the model registry omits max_output_tokens. */
const DEFAULT_MAX_TOKENS_PER_TURN = 16_384;

/**
 * Providers bill images by resolution (~1–2k tokens), not base64 length —
 * pricing raw bytes would overestimate ~100x and falsely exhaust the budget.
 */
const IMAGE_INPUT_TOKEN_ESTIMATE = 2_000;

function estimateInputTokens(system: string, messages: ChatMessage[], tools: ToolDef[]): number {
  let bytes = system.length + JSON.stringify(tools).length;
  let images = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "image") images += 1;
      else bytes += JSON.stringify(b).length;
    }
  }
  return Math.ceil((bytes / 4) * 1.25) + images * IMAGE_INPUT_TOKEN_ESTIMATE;
}

/** Agent loop: provider → tools → repeat until done or budget-exhausted wrap-up. */
export class Agent {
  private depth: number;
  private label: string;
  private system: string;
  /** Own provider turns only (stats.turns includes the subtree). */
  private ownTurns = 0;
  private directChildren = 0;
  private taskStore: TaskStore = { list: [] };
  private stats: AgentStats = {
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

  constructor(private opts: AgentOptions) {
    this.depth = opts.depth ?? 0;
    this.label = opts.label ?? (this.depth === 0 ? "agent" : `sub${this.depth}`);
    const skills = indexSkills(opts.workspace);
    this.system =
      opts.systemPrompt ??
      buildSystemPrompt({
        skills,
        isSubagent: this.depth > 0,
        canSpawn: this.canSpawn && opts.tools.some((t) => t.def.name === "spawn_agent"),
      });
  }

  private get canSpawn(): boolean {
    return this.depth < MAX_SPAWN_DEPTH;
  }

  private activeTools(): Tool[] {
    return this.canSpawn
      ? this.opts.tools
      : this.opts.tools.filter((t) => t.def.name !== "spawn_agent");
  }

  private toolContext(): ToolContext {
    return {
      workspace: this.opts.workspace,
      depth: this.depth,
      budget: this.opts.budget,
      transcript: this.opts.transcript,
      spawn: this.canSpawn ? (task) => this.spawnChild(task) : undefined,
      tasks: this.taskStore,
    };
  }

  private async spawnChild(task: string): Promise<string> {
    this.directChildren += 1;
    this.stats.subagentsSpawned += 1;
    const childLabel = `${this.label}.${this.directChildren}`;
    // Children share the run's BudgetTracker via this.opts.
    const child = new Agent({
      ...this.opts,
      depth: this.depth + 1,
      label: childLabel,
      systemPrompt: undefined, // children get the standard subagent prompt
    });
    try {
      const result = await child.run(task);
      return result.finalText || "(subagent finished with no final text)";
    } finally {
      // Roll up even if the child threw mid-run so partial accounting survives.
      const cs = child.snapshotStats();
      this.stats.turns += cs.turns;
      this.stats.costUsd += cs.costUsd;
      this.stats.inputTokens += cs.inputTokens;
      this.stats.cachedInputTokens += cs.cachedInputTokens;
      this.stats.outputTokens += cs.outputTokens;
      this.stats.subagentsSpawned += cs.subagentsSpawned;
      this.stats.imagesSent += cs.imagesSent;
      for (const [name, n] of Object.entries(cs.toolCalls)) {
        this.stats.toolCalls[name] = (this.stats.toolCalls[name] ?? 0) + n;
      }
      for (const m of cs.servedModels) {
        if (!this.stats.servedModels.includes(m)) this.stats.servedModels.push(m);
      }
    }
  }

  /** Snapshot for partial accounting if run() aborts mid-flight. */
  snapshotStats(): AgentStats {
    return {
      ...this.stats,
      toolCalls: { ...this.stats.toolCalls },
      servedModels: [...this.stats.servedModels],
    };
  }

  async run(initialUserMessage: string): Promise<AgentResult> {
    const { provider, model, budget, transcript } = this.opts;
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: initialUserMessage }] },
    ];
    let finalText = "";
    let wrappingUp = false;
    let justNudged = false;

    for (;;) {
      // Always send tools — Anthropic/Gemini reject history with tool blocks
      // when `tools` is absent. Wrap-up uses toolChoice "none" instead.
      const tools = this.activeTools().map((t) => t.def);
      const toolChoice = wrappingUp ? ("none" as const) : undefined;

      const remWallMs = budget.remainingWallMs();
      if (remWallMs <= WALL_GRACE_MS) {
        const reason = `wall-clock budget exhausted (${Math.round(remWallMs / 1000)}s remaining)`;
        if (!this.stats.budgetExhausted) this.stats.budgetExhausted = reason;
        transcript.log("budget", this.label, this.depth, { reason, skippedFinalCall: true });
        break;
      }
      // Cap fetch timeout to remaining wall so one hung request can't blow the cap.
      const timeoutMs = Math.min(PROVIDER_TIMEOUT_CAP_MS, remWallMs + WALL_GRACE_MS);

      const reservation = budget.reserveCall(
        estimateInputTokens(this.system, messages, tools),
        this.opts.maxTokensPerTurn ?? model.max_output_tokens ?? DEFAULT_MAX_TOKENS_PER_TURN,
        model.pricing,
        ...(wrappingUp ? [WRAPUP_OUTPUT_FLOOR_TOKENS] : []),
      );
      if (!reservation) {
        if (wrappingUp) {
          transcript.log("budget", this.label, this.depth, {
            reason: this.stats.budgetExhausted ?? "cost budget exhausted",
            skippedFinalCall: true,
          });
          break;
        }
        if (justNudged) {
          // Finish-confirmation was pending; keep the prior summary rather than
          // spending a wrap-up call that would replace it with a stub.
          const reason = "cost budget exhausted before the finish-confirmation reply";
          this.stats.budgetExhausted = reason;
          transcript.log("budget", this.label, this.depth, { reason, skippedFinalCall: true });
          break;
        }
        // Switch to wrap-up; it re-reserves with a lower output floor.
        const reason = "cost budget exhausted (next call's worst case exceeds remaining budget)";
        this.stats.budgetExhausted = reason;
        transcript.log("budget", this.label, this.depth, { reason });
        wrappingUp = true;
        const wrapBlock: ContentBlock = { type: "text", text: wrapUpText(reason) };
        const last = messages[messages.length - 1];
        // Fold into the trailing user message to keep user/assistant alternation.
        if (last && last.role === "user") last.content.push(wrapBlock);
        else messages.push({ role: "user", content: [wrapBlock] });
        continue;
      }

      this.ownTurns += 1;
      this.stats.turns += 1;
      budget.addTurn();
      transcript.log("request", this.label, this.depth, {
        turn: this.ownTurns,
        model: model.id,
        toolsEnabled: !wrappingUp,
        maxTokens: reservation.maxTokens,
      });

      let response: ChatResponse;
      try {
        response = await provider.chat({
          model: model.provider_model_id,
          system: this.system,
          messages,
          tools,
          maxTokens: reservation.maxTokens,
          timeoutMs,
          // Omit sampler params unless set — several reasoning APIs reject non-default temperature.
          ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
          ...(toolChoice ? { toolChoice } : {}),
          ...(model.thinking ? { thinking: model.thinking } : {}),
          ...(model.reasoning_effort ? { reasoningEffort: model.reasoning_effort } : {}),
        });
      } catch (e: any) {
        budget.release(reservation);
        transcript.log("error", this.label, this.depth, { message: e?.message ?? String(e) });
        throw e;
      }

      if (response.servedModel && !this.stats.servedModels.includes(response.servedModel)) {
        this.stats.servedModels.push(response.servedModel);
        if (response.servedModel !== model.provider_model_id) {
          transcript.log("warn", this.label, this.depth, {
            message: `provider served model "${response.servedModel}" but "${model.provider_model_id}" was requested`,
          });
        }
      }

      const turnCost = costOf(model, response.usage);
      budget.settle(reservation, turnCost, response.usage.inputTokens + response.usage.outputTokens);
      this.stats.inputTokens += response.usage.inputTokens;
      this.stats.cachedInputTokens += response.usage.cachedInputTokens ?? 0;
      this.stats.outputTokens += response.usage.outputTokens;
      this.stats.costUsd += turnCost;

      const text = response.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      transcript.log("response", this.label, this.depth, {
        turn: this.ownTurns,
        text,
        toolCalls: toolUses.map((t) => t.name),
        stopReason: response.stopReason,
        inputTokens: response.usage.inputTokens,
        ...(response.usage.cachedInputTokens
          ? { cachedInputTokens: response.usage.cachedInputTokens }
          : {}),
        ...(response.usage.cacheWriteInputTokens
          ? { cacheWriteInputTokens: response.usage.cacheWriteInputTokens }
          : {}),
        outputTokens: response.usage.outputTokens,
        costUsd: turnCost,
        totalUsd: this.stats.costUsd,
      });

      messages.push({ role: "assistant", content: response.content });
      // After a finish nudge, keep the longer prior summary over a terse "done."
      const trimmed = text.trim();
      if (trimmed && !(justNudged && trimmed.length < finalText.length)) {
        finalText = trimmed;
      }

      if (toolUses.length === 0) {
        // One nudge for models that narrate the next action then stop without calling.
        if (wrappingUp || justNudged) break;
        justNudged = true;
        transcript.log("warn", this.label, this.depth, {
          message: "reply had no tool calls — sent the finish-confirmation nudge",
        });
        messages.push({
          role: "user",
          content: [{ type: "text", text: FINISH_NUDGE_TEXT }],
        });
        continue;
      }
      if (wrappingUp) break;
      justNudged = false;

      const results: ContentBlock[] = await this.executeToolCalls(toolUses);

      // max_tokens often truncates the last tool call mid-JSON; tell the model
      // so it doesn't retry the same oversized call forever.
      if (response.stopReason === "max_tokens") {
        results.push({
          type: "text",
          text: `Note: your reply was cut off at the per-turn output limit (${reservation.maxTokens} tokens), so your last tool call's arguments were likely truncated — that is why it failed, not formatting. Produce large content in smaller pieces (e.g. write_file the first part, then write_file with append: true for the rest).`,
        });
      }

      const reason = budget.exceeded();
      if (reason) {
        this.stats.budgetExhausted = reason;
        transcript.log("budget", this.label, this.depth, { reason });
        wrappingUp = true;
        // Same user message as tool results — some providers reject consecutive user turns.
        messages.push({
          role: "user",
          content: [...results, { type: "text", text: wrapUpText(reason) }],
        });
      } else {
        messages.push({ role: "user", content: results });
      }
    }

    return { finalText, stats: this.stats };
  }

  /**
   * spawn_agent runs concurrently; other tools run in order. Vision models
   * get screenshots after tool_result blocks; text-only models drop them.
   */
  private async executeToolCalls(calls: ToolUseBlock[]): Promise<ContentBlock[]> {
    const { transcript } = this.opts;
    const byName = new Map(this.activeTools().map((t) => [t.def.name, t]));
    const ctx = this.toolContext();
    const vision = this.opts.model.vision === true;
    const results = new Array<ToolResultBlock>(calls.length);
    const images = new Array<ToolImage[]>(calls.length);

    const runOne = async (call: ToolUseBlock, idx: number) => {
      this.stats.toolCalls[call.name] = (this.stats.toolCalls[call.name] ?? 0) + 1;
      const tool = byName.get(call.name);
      transcript.log("tool_call", this.label, this.depth, {
        tool: call.name,
        summary: summarizeInput(call.input),
      });
      let output: string;
      let isError: boolean;
      let toolImages: ToolImage[] = [];
      if (!tool) {
        output = `unknown tool: ${call.name}`;
        isError = true;
      } else {
        const r = await runTool(tool, call.input, ctx);
        ({ output, isError } = r);
        if (vision && r.images) toolImages = r.images;
      }
      transcript.log("tool_result", this.label, this.depth, {
        tool: call.name,
        isError,
        output: output.slice(0, 4000),
        ...(toolImages.length > 0 ? { imagesAttached: toolImages.length } : {}),
      });
      results[idx] = {
        type: "tool_result",
        tool_use_id: call.id,
        content: output,
        ...(isError ? { is_error: true } : {}),
      };
      images[idx] = toolImages;
    };

    const spawnJobs: Promise<void>[] = [];
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].name === "spawn_agent") {
        spawnJobs.push(runOne(calls[i], i));
      } else {
        await runOne(calls[i], i);
      }
    }
    await Promise.all(spawnJobs);

    // Anthropic requires tool_result blocks to lead the user message.
    const blocks: ContentBlock[] = [...results];
    for (const group of images) {
      for (const img of group ?? []) {
        blocks.push({ type: "text", text: img.label });
        blocks.push({ type: "image", media_type: img.media_type, data: img.data });
        this.stats.imagesSent += 1;
      }
    }
    return blocks;
  }
}

/** One-shot nudge when a reply has no tool calls; a second tool-less reply ends the agent. */
const FINISH_NUDGE_TEXT =
  "Your reply contained no tool calls, which ends your run. If the work is complete, reply with your final summary. If not, continue — actions only happen through tool calls.";

function wrapUpText(reason: string): string {
  return `Budget exhausted (${reason}). You cannot call any more tools — wrap up: reply with a final summary of what you completed and the current state of the work.`;
}

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(input);
  }
}
