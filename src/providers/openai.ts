import {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Provider,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
  fetchJson,
} from "./types.js";

/**
 * Direct api.openai.com uses Responses (reasoning models reject tools on
 * chat/completions). Other OpenAI-compatible endpoints use Chat Completions.
 * OpenRouter: request usage and prefer its reported cost.
 */
export class OpenAIProvider implements Provider {
  readonly name = "openai";

  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {}

  private get isOpenRouter(): boolean {
    return this.baseURL.includes("openrouter.ai");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    return this.baseURL.includes("api.openai.com")
      ? this.chatResponses(req)
      : this.chatCompletions(req);
  }

  private buildResponsesInput(req: ChatRequest): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];
    for (const m of req.messages) {
      for (const b of m.content) {
        if (m.role === "assistant") {
          if (b.type === "openai_reasoning") {
            input.push(b.item as Record<string, unknown>);
          } else if (b.type === "text" && b.text) {
            input.push({ role: "assistant", content: [{ type: "output_text", text: b.text }] });
          } else if (b.type === "tool_use") {
            input.push(
              (b.responsesItem as Record<string, unknown>) ?? {
                type: "function_call",
                call_id: b.id,
                name: b.name,
                arguments: JSON.stringify(b.input ?? {}),
              },
            );
          }
        } else if (b.type === "tool_result") {
          input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content });
        } else if (b.type === "text" && b.text) {
          input.push({ role: "user", content: [{ type: "input_text", text: b.text }] });
        } else if (b.type === "image") {
          // Images can't go inside function_call_output — follow as input_image.
          input.push({
            role: "user",
            content: [
              { type: "input_image", image_url: `data:${b.media_type};base64,${b.data}` },
            ],
          });
        }
      }
    }
    return input;
  }

  private buildResponsesBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: this.buildResponsesInput(req),
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: req.maxTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools.length > 0) {
      // Plain JSON Schema, not the strict-mode subset.
      body.tools = req.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      }));
      if (req.toolChoice === "none") body.tool_choice = "none";
    }
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    return body;
  }

  private async chatResponses(req: ChatRequest): Promise<ChatResponse> {
    const json = await fetchJson(
      this.name,
      `${this.baseURL.replace(/\/$/, "")}/responses`,
      { authorization: `Bearer ${this.apiKey}` },
      this.buildResponsesBody(req),
      req.timeoutMs,
    );
    return this.parseResponses(json);
  }

  private parseResponses(json: any): ChatResponse {
    const content: ContentBlock[] = [];
    let sawToolCall = false;
    for (const item of json.output ?? []) {
      if (item.type === "reasoning") {
        content.push({ type: "openai_reasoning", item });
      } else if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
          else if (c.type === "refusal" && c.refusal) content.push({ type: "text", text: c.refusal });
        }
      } else if (item.type === "function_call") {
        sawToolCall = true;
        let args: unknown = {};
        try {
          args = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          args = { __raw: item.arguments };
        }
        const block: ToolUseBlock = {
          type: "tool_use",
          // call_id for function_call_output; item id kept on responsesItem for replay.
          id: item.call_id ?? item.id,
          name: item.name ?? "unknown",
          input: args,
          responsesItem: item,
        };
        content.push(block);
      }
    }

    let stopReason: StopReason;
    if (json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens") {
      stopReason = "max_tokens";
    } else if (sawToolCall) {
      stopReason = "tool_use";
    } else if (json.status === "completed") {
      stopReason = "end_turn";
    } else {
      stopReason = "other";
    }

    const usage = json.usage ?? {};
    // input_tokens includes cached; cached_tokens is the billed subset.
    const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
    return {
      content,
      stopReason,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(cachedTokens > 0 ? { cachedInputTokens: cachedTokens } : {}),
      },
      ...(typeof json.model === "string" ? { servedModel: json.model } : {}),
    };
  }

  private async chatCompletions(req: ChatRequest): Promise<ChatResponse> {
    const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];

    for (const m of req.messages) {
      if (m.role === "assistant") {
        const reasoningContent = m.content
          .filter((b) => b.type === "chat_reasoning")
          .map((b) => b.reasoningContent)
          .join("\n");
        const text = m.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
        const toolCalls = m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const t = b as { id: string; name: string; input: unknown };
            return {
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
            };
          });
        // Strict providers (Moonshot) 400 on an assistant message with neither
        // content nor tool_calls, and it would carry nothing anyway — drop it.
        if (!reasoningContent && !text && toolCalls.length === 0) continue;
        const msg: Record<string, unknown> = { role: "assistant", content: text || null };
        if (reasoningContent) msg.reasoning_content = reasoningContent;
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push(msg);
      } else {
        // tool_result → role:"tool"; text/images → user (parts if images, else string).
        const results = m.content.filter((b) => b.type === "tool_result") as ToolResultBlock[];
        for (const r of results) {
          messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
        }
        const parts: Record<string, unknown>[] = [];
        for (const b of m.content) {
          if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
          else if (b.type === "image")
            parts.push({
              type: "image_url",
              image_url: { url: `data:${b.media_type};base64,${b.data}` },
            });
        }
        if (parts.length > 0) {
          const hasImage = parts.some((p) => p.type === "image_url");
          messages.push({
            role: "user",
            content: hasImage ? parts : parts.map((p) => p.text as string).join("\n"),
          });
        }
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
    };
    // GPT-5 reasoning rejects non-default temperature with a 400.
    if (req.temperature !== undefined) body.temperature = req.temperature;
    body.max_tokens = req.maxTokens;
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      if (req.toolChoice === "none") body.tool_choice = "none";
    }
    if (req.reasoningEffort) {
      // OpenRouter: unified `reasoning`; others: Chat Completions `reasoning_effort`.
      if (this.isOpenRouter) body.reasoning = { effort: req.reasoningEffort };
      else body.reasoning_effort = req.reasoningEffort;
    }
    if (this.isOpenRouter) body.usage = { include: true };

    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (this.isOpenRouter) {
      headers["http-referer"] = "https://github.com/sebnado/worldbuild-bench";
      headers["x-title"] = "WorldBuild Bench";
    }

    const json = await fetchJson(
      this.name,
      `${this.baseURL.replace(/\/$/, "")}/chat/completions`,
      headers,
      body,
      req.timeoutMs,
    );

    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const content: ContentBlock[] = [];
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
      content.push({ type: "chat_reasoning", reasoningContent: msg.reasoning_content });
    }
    if (typeof msg.content === "string" && msg.content.length > 0) {
      content.push({ type: "text", text: msg.content });
    }
    let i = 0;
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { __raw: tc.function?.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? `call_${i++}`,
        name: tc.function?.name ?? "unknown",
        input,
      });
    }

    const finishMap: Record<string, StopReason> = {
      stop: "end_turn",
      tool_calls: "tool_use",
      length: "max_tokens",
    };

    const usage = json.usage ?? {};
    // prompt_tokens includes cached; cached_tokens is the billed subset.
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
    return {
      content,
      stopReason: finishMap[choice?.finish_reason as string] ?? "other",
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        ...(cachedTokens > 0 ? { cachedInputTokens: cachedTokens } : {}),
        ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
      },
      ...(typeof json.model === "string" ? { servedModel: json.model } : {}),
    };
  }
}
