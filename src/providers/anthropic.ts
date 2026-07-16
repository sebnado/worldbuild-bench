import {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Provider,
  StopReason,
  fetchJson,
} from "./types.js";

/** Anthropic Messages API adapter (native tool use, no SDK). */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";

  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages = req.messages.map((m) => ({
        role: m.role,
        content: m.content.flatMap((b): Record<string, unknown>[] => {
          if (b.type === "text") return [{ type: "text", text: b.text }];
          if (b.type === "tool_use")
            return [{ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }];
          if (b.type === "tool_result")
            return [
              {
                type: "tool_result",
                tool_use_id: b.tool_use_id,
                content: b.content,
                ...(b.is_error ? { is_error: true } : {}),
              },
            ];
          if (b.type === "image")
            return [
              {
                type: "image",
                source: { type: "base64", media_type: b.media_type, data: b.data },
              },
            ];
          // Thinking must be replayed exactly when thinking + tool use are enabled.
          if (b.type === "thinking")
            return [
              {
                type: "thinking",
                thinking: b.thinking,
                ...(b.signature ? { signature: b.signature } : {}),
              },
            ];
          if (b.type === "redacted_thinking")
            return [{ type: "redacted_thinking", data: b.data }];
          return [];
        }),
      }));

    // Anthropic caching is opt-in (unlike OpenAI/Gemini). Breakpoints on system
    // + last content block so each turn reads the prior prefix from cache.
    const lastBlocks = messages[messages.length - 1]?.content;
    const lastBlock = lastBlocks?.[lastBlocks.length - 1];
    if (
      lastBlock &&
      (lastBlock.type === "text" || lastBlock.type === "tool_result" || lastBlock.type === "image")
    ) {
      lastBlock.cache_control = { type: "ephemeral" };
    }

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.thinking === "adaptive") body.thinking = { type: "adaptive" };
    // Models without adaptive thinking reject output_config.effort (400).
    if (req.reasoningEffort && req.thinking === "adaptive")
      body.output_config = { effort: req.reasoningEffort };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
      if (req.toolChoice === "none") body.tool_choice = { type: "none" };
    }

    const json = await fetchJson(
      this.name,
      `${this.baseURL.replace(/\/$/, "")}/v1/messages`,
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      req.timeoutMs,
    );

    const content: ContentBlock[] = [];
    for (const b of json.content ?? []) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use")
        content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      else if (b.type === "thinking")
        content.push({
          type: "thinking",
          thinking: b.thinking ?? "",
          ...(b.signature ? { signature: b.signature } : {}),
        });
      else if (b.type === "redacted_thinking")
        content.push({ type: "redacted_thinking", data: b.data });
    }

    const stopMap: Record<string, StopReason> = {
      end_turn: "end_turn",
      tool_use: "tool_use",
      max_tokens: "max_tokens",
      stop_sequence: "end_turn",
      refusal: "refusal",
      pause_turn: "pause_turn",
      model_context_window_exceeded: "max_tokens",
    };

    // Anthropic input_tokens excludes cache read/write — normalize to total input.
    const u = json.usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return {
      content,
      stopReason: stopMap[json.stop_reason as string] ?? "other",
      usage: {
        inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite,
        outputTokens: u.output_tokens ?? 0,
        ...(cacheRead > 0 ? { cachedInputTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteInputTokens: cacheWrite } : {}),
      },
      ...(typeof json.model === "string" ? { servedModel: json.model } : {}),
    };
  }
}
