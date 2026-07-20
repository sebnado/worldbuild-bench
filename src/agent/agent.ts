import {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  Provider,
  ToolDef,
  ToolResultBlock,
  ToolUseBlock,
} from "../providers/types.js";
import { ModelEntry, costOf, nativeReasoningEffortOf } from "../providers/index.js";
import { BudgetTracker } from "./budget.js";
import { Transcript } from "./transcript.js";
import { buildSystemPrompt, indexSkills } from "./prompts.js";
import { TaskItem, TaskStore, Tool, ToolContext, ToolImage, runTool } from "../tools/index.js";
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
  /** Called whenever the root reaches a durable conversation/tool boundary. */
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void;
  /**
   * Resume from a prior checkpoint instead of starting fresh. The root agent
   * continues the loaded conversation (ignoring initialUserMessage) and seeds
   * its cumulative stats from the checkpoint. No-op for subagents.
   */
  resumeState?: AgentCheckpoint;
}

export interface AgentRuntimeState {
  /** Root's own provider-turn count, for transcript numbering continuity. */
  ownTurns: number;
  /** Number of direct children allocated so resumed transcript labels stay unique. */
  directChildren: number;
  /** Runtime state behind update_tasks; the rendered revisions also remain in context. */
  tasks: TaskItem[];
}

export interface CheckpointToolCall {
  call: ToolUseBlock;
  status: "pending" | "running" | "completed";
  result?: ToolResultBlock;
  images?: ToolImage[];
}

/** A resumable snapshot of the root agent, persisted incrementally. */
export interface AgentCheckpoint extends AgentRuntimeState {
  /** Full conversation history at the last durable boundary. */
  messages: ChatMessage[];
  finalText: string;
  /** Cumulative stats (root + subtree) as of this checkpoint. */
  stats: AgentStats;
  /** Present while an assistant tool-call turn has not reached a clean result boundary. */
  inFlightToolCalls?: CheckpointToolCall[];
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

/** Below this remaining wall budget, no further call is issued. */
const WALL_GRACE_MS = 5_000;
const PROVIDER_TIMEOUT_CAP_MS = 600_000;
/** Wrap-up calls reserve whatever output still fits (no 512-token floor). */
const WRAPUP_OUTPUT_FLOOR_TOKENS = 1;
/** Fallback when the model registry omits max_output_tokens. */
const DEFAULT_MAX_TOKENS_PER_TURN = 16_384;
/** Consecutive empty provider replies tolerated before the agent gives up. */
const MAX_EMPTY_REPLIES = 4;
const EMPTY_REPLY_BACKOFF_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (opts.resumeState) {
      // Carry prior spend forward so cumulative accounting spans both segments;
      // budgetExhausted resets — the fresh budget window has its own fate.
      this.stats = {
        ...opts.resumeState.stats,
        budgetExhausted: null,
        toolCalls: { ...opts.resumeState.stats.toolCalls },
        servedModels: [...opts.resumeState.stats.servedModels],
      };
      this.ownTurns = opts.resumeState.ownTurns;
      this.directChildren =
        opts.resumeState.directChildren ?? opts.resumeState.stats.subagentsSpawned;
      this.taskStore = { list: structuredClone(opts.resumeState.tasks ?? []) };
    }
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

  private allocateChildLabel(): string {
    this.directChildren += 1;
    return `${this.label}.${this.directChildren}`;
  }

  private async spawnChild(task: string, allocatedLabel?: string): Promise<string> {
    this.stats.subagentsSpawned += 1;
    const childLabel = allocatedLabel ?? this.allocateChildLabel();
    // Children share the run's BudgetTracker via this.opts.
    const child = new Agent({
      ...this.opts,
      depth: this.depth + 1,
      label: childLabel,
      systemPrompt: undefined, // children get the standard subagent prompt
      resumeState: undefined, // resume/checkpoint are root-only concerns
      onCheckpoint: undefined,
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

  snapshotRuntimeState(): AgentRuntimeState {
    return {
      ownTurns: this.ownTurns,
      directChildren: this.directChildren,
      tasks: structuredClone(this.taskStore.list),
    };
  }

  async run(initialUserMessage: string): Promise<AgentResult> {
    const { provider, model, budget, transcript } = this.opts;
    const resume = this.opts.resumeState;
    const messages: ChatMessage[] = resume
      ? structuredClone(resume.messages)
      : [{ role: "user", content: [{ type: "text", text: initialUserMessage }] }];
    let finalText = resume?.finalText ?? "";
    let wrappingUp = false;
    let justNudged = false;
    let emptyReplies = 0;

    // A process may have stopped after an assistant emitted tool calls but
    // before every result was durably recorded. Never replay an operation whose
    // side effects are uncertain. Complete the interrupted assistant turn with
    // explicit tool results so the model can inspect the workspace and decide.
    if (resume?.inFlightToolCalls?.length) {
      const results = this.recoverInterruptedToolCalls(resume.inFlightToolCalls);
      messages.push({ role: "user", content: results });
      transcript.log("warn", this.label, this.depth, {
        message: `recovered ${resume.inFlightToolCalls.length} interrupted tool call(s) without replaying them`,
      });
      this.checkpoint(messages, finalText);
    }

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
          ...(model.reasoning_effort
            ? { reasoningEffort: nativeReasoningEffortOf(model) }
            : {}),
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

      // A reply with neither text nor tool calls has no actionable output and
      // serializes as an empty assistant message on most providers. Retry it
      // without poisoning later turns; opaque reasoning alone is not replayable
      // without an accompanying tool call or answer.
      if (toolUses.length === 0 && !text.trim()) {
        emptyReplies += 1;
        transcript.log("warn", this.label, this.depth, {
          message: `empty reply from provider (${emptyReplies}/${MAX_EMPTY_REPLIES}) — retrying without adding it to history`,
        });
        if (emptyReplies >= MAX_EMPTY_REPLIES) {
          this.stats.budgetExhausted ??= `provider returned ${MAX_EMPTY_REPLIES} consecutive empty replies`;
          break;
        }
        await sleep(EMPTY_REPLY_BACKOFF_MS * emptyReplies);
        continue;
      }
      emptyReplies = 0;

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

      const inFlight: CheckpointToolCall[] = toolUses.map((call) => ({
        call: structuredClone(call),
        status: "pending",
      }));
      // Persist the assistant turn before any tool can mutate the workspace.
      this.checkpoint(messages, finalText, inFlight);
      const results: ContentBlock[] = await this.executeToolCalls(toolUses, inFlight, () =>
        this.checkpoint(messages, finalText, inFlight),
      );

      // max_tokens often truncates the last tool call mid-JSON; tell the model
      // so it doesn't retry the same oversized call forever.
      if (response.stopReason === "max_tokens") {
        results.push({
          type: "text",
          text: `Note: your reply was cut off at the per-turn output limit (${reservation.maxTokens} tokens), so your last tool call's arguments were likely truncated — that is why it failed, not formatting. Produce large content in smaller pieces (e.g. write_file the first part, then write_file with append: true for the rest).`,
        });
      }

      // Clean turn boundary: history ends on a tool-result user message the
      // loop can resume from. Checkpoint the clean state even when the budget
      // just tripped — otherwise this round's tool results (and a first-round
      // exhaustion's only checkpoint) would be lost to resume.
      messages.push({ role: "user", content: results });
      this.checkpoint(messages, finalText);

      const reason = budget.exceeded();
      if (reason) {
        this.stats.budgetExhausted = reason;
        transcript.log("budget", this.label, this.depth, { reason });
        wrappingUp = true;
        // Append the wrap-up instruction into the same user message (the one
        // just checkpointed clean) — some providers reject consecutive user turns.
        messages[messages.length - 1].content.push({ type: "text", text: wrapUpText(reason) });
      }
    }

    return { finalText, stats: this.stats };
  }

  /** Persist a resumable snapshot (root agent only). */
  private checkpoint(
    messages: ChatMessage[],
    finalText: string,
    inFlightToolCalls?: CheckpointToolCall[],
  ): void {
    if (this.depth !== 0 || !this.opts.onCheckpoint) return;
    this.opts.onCheckpoint({
      messages,
      finalText,
      stats: this.snapshotStats(),
      ...this.snapshotRuntimeState(),
      ...(inFlightToolCalls ? { inFlightToolCalls } : {}),
    });
  }

  private recoverInterruptedToolCalls(calls: CheckpointToolCall[]): ContentBlock[] {
    const results: ToolResultBlock[] = [];
    const imageGroups: ToolImage[][] = [];
    for (const state of calls) {
      if (state.status === "completed" && state.result) {
        results.push(structuredClone(state.result));
        imageGroups.push(structuredClone(state.images ?? []));
        continue;
      }
      const definitelyPending = state.status === "pending";
      results.push({
        type: "tool_result",
        tool_use_id: state.call.id,
        is_error: true,
        content: definitelyPending
          ? `Tool execution was interrupted before this call started. It was not replayed; retry it if it is still needed.`
          : `Tool execution was interrupted before a durable result was recorded. It was not replayed because its side effects may already exist. Inspect the workspace before deciding whether to retry.`,
      });
      imageGroups.push([]);
    }
    const blocks: ContentBlock[] = [...results];
    for (const group of imageGroups) {
      for (const img of group) {
        blocks.push({ type: "text", text: img.label });
        blocks.push({ type: "image", media_type: img.media_type, data: img.data });
      }
    }
    return blocks;
  }

  /**
   * spawn_agent runs concurrently; other tools run in order. Vision models
   * get screenshots after tool_result blocks; text-only models drop them.
   */
  private async executeToolCalls(
    calls: ToolUseBlock[],
    states: CheckpointToolCall[],
    onProgress: () => void,
  ): Promise<ContentBlock[]> {
    const { transcript } = this.opts;
    const byName = new Map(this.activeTools().map((t) => [t.def.name, t]));
    const ctx = this.toolContext();
    const vision = this.opts.model.vision === true;
    const results = new Array<ToolResultBlock>(calls.length);
    const images = new Array<ToolImage[]>(calls.length);

    const runOne = async (call: ToolUseBlock, idx: number) => {
      let callContext = ctx;
      if (call.name === "spawn_agent") {
        const childLabel = this.allocateChildLabel();
        callContext = { ...ctx, spawn: (task) => this.spawnChild(task, childLabel) };
      }
      this.stats.toolCalls[call.name] = (this.stats.toolCalls[call.name] ?? 0) + 1;
      states[idx].status = "running";
      onProgress();
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
        const r = await runTool(tool, call.input, callContext);
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
      this.stats.imagesSent += toolImages.length;
      states[idx].status = "completed";
      states[idx].result = structuredClone(results[idx]);
      states[idx].images = structuredClone(toolImages);
      onProgress();
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
