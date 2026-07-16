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

/** Gemini generateContent adapter. Synthesizes call ids (API has none). */
export class GoogleProvider implements Provider {
  readonly name = "google";

  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const idToName = new Map<string, string>();
    for (const m of req.messages) {
      for (const b of m.content) {
        if (b.type === "tool_use") idToName.set(b.id, b.name);
      }
    }

    const contents: Record<string, unknown>[] = [];
    for (const m of req.messages) {
      const role = m.role === "assistant" ? "model" : "user";
      const parts: Record<string, unknown>[] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          const t = b as ToolUseBlock;
          parts.push({
            functionCall: { name: t.name, args: t.input ?? {} },
            ...(t.thoughtSignature ? { thoughtSignature: t.thoughtSignature } : {}),
          });
        } else if (b.type === "tool_result") {
          const r = b as ToolResultBlock;
          parts.push({
            functionResponse: {
              name: idToName.get(r.tool_use_id) ?? "unknown",
              response: { result: r.content, ...(r.is_error ? { error: true } : {}) },
            },
          });
        } else if (b.type === "image") {
          // Images can't go inside functionResponse — follow as inlineData.
          parts.push({ inlineData: { mimeType: b.media_type, data: b.data } });
        }
      }
      if (parts.length > 0) contents.push({ role, parts });
    }

    const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    // thinkingLevel LOW|MEDIUM|HIGH only (xhigh → HIGH); exclusive with thinkingBudget.
    if (req.reasoningEffort) {
      generationConfig.thinkingConfig = {
        thinkingLevel: req.reasoningEffort === "xhigh" ? "HIGH" : req.reasoningEffort.toUpperCase(),
      };
    }

    const body: Record<string, unknown> = {
      contents,
      systemInstruction: { parts: [{ text: req.system }] },
      generationConfig,
    };
    if (req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
      if (req.toolChoice === "none") {
        body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      }
    }

    const url = `${this.baseURL.replace(/\/$/, "")}/v1beta/models/${req.model}:generateContent`;
    const json = await fetchJson(
      this.name,
      url,
      { "x-goog-api-key": this.apiKey },
      body,
      req.timeoutMs,
    );

    const candidate = json.candidates?.[0];
    const content: ContentBlock[] = [];
    let callIdx = 0;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought === true) continue; // thought summaries aren't replayable text
      if (typeof part.text === "string" && part.text.length > 0) {
        content.push({ type: "text", text: part.text });
      } else if (part.functionCall) {
        content.push({
          type: "tool_use",
          id: `gcall_${Date.now()}_${callIdx++}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          ...(typeof part.thoughtSignature === "string"
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        });
      }
    }

    const hasCalls = content.some((b) => b.type === "tool_use");
    const finish: string = candidate?.finishReason ?? "";
    let stopReason: StopReason = "other";
    if (hasCalls) stopReason = "tool_use";
    else if (finish === "STOP") stopReason = "end_turn";
    else if (finish === "MAX_TOKENS") stopReason = "max_tokens";

    const um = json.usageMetadata ?? {};
    // promptTokenCount includes cached; cachedContentTokenCount is the billed subset.
    const cachedTokens = um.cachedContentTokenCount ?? 0;
    return {
      content,
      stopReason,
      usage: {
        inputTokens: um.promptTokenCount ?? 0,
        outputTokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
        ...(cachedTokens > 0 ? { cachedInputTokens: cachedTokens } : {}),
      },
      ...(typeof json.modelVersion === "string" ? { servedModel: json.modelVersion } : {}),
    };
  }
}
