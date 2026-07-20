import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { GoogleProvider } from "../src/providers/google.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import {
  ChatRequest,
  ProviderHttpError,
  ProviderTransportError,
  fetchJson,
  isTerminalHttpError,
} from "../src/providers/types.js";
import {
  getModel,
  loadRegistry,
  nativeReasoningEffortOf,
  setReasoningEffort,
} from "../src/providers/index.js";

/** Stub global fetch, capture request bodies, return a scripted JSON reply. */
async function withFetchStub<T>(
  replies: unknown[],
  fn: (captured: any[]) => Promise<T>,
): Promise<T> {
  const captured: any[] = [];
  const orig = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.push(JSON.parse(init.body));
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as any;
  try {
    return await fn(captured);
  } finally {
    globalThis.fetch = orig;
  }
}

const BASE_REQ: Omit<ChatRequest, "messages"> = {
  model: "test-model",
  system: "sys",
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object" } }],
  maxTokens: 100,
};

test("anthropic: wrap-up keeps tools + tool_choice none, replays thinking, omits temperature", async () => {
  const reply = {
    model: "served-model-id",
    content: [
      { type: "thinking", thinking: "planning", signature: "sig2" },
      { type: "text", text: "ok" },
    ],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 20,
    },
  };
  await withFetchStub([reply], async (captured) => {
    const p = new AnthropicProvider("https://api.example.invalid", "k");
    const res = await p.chat({
      ...BASE_REQ,
      toolChoice: "none",
      thinking: "adaptive",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig1" },
            { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "out" },
            { type: "text", text: "Budget exhausted (cost). wrap up" },
          ],
        },
      ],
    });

    const body = captured[0];
    // No sampling params by default (reasoning APIs reject non-defaults).
    assert.equal(body.temperature, undefined);
    // Adaptive thinking flag forwarded.
    assert.deepEqual(body.thinking, { type: "adaptive" });
    // Tools still present on the wrap-up turn; calls forbidden via tool_choice.
    assert.equal(body.tools.length, 1);
    assert.deepEqual(body.tool_choice, { type: "none" });
    // Thinking blocks replayed verbatim with their signature.
    assert.deepEqual(body.messages[1].content[0], {
      type: "thinking",
      thinking: "hmm",
      signature: "sig1",
    });
    // Prompt caching: system prompt carries a cache_control breakpoint...
    assert.deepEqual(body.system, [
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    // ...and so does the last content block of the last message (only it).
    const lastMsg = body.messages[body.messages.length - 1];
    assert.deepEqual(lastMsg.content[lastMsg.content.length - 1].cache_control, {
      type: "ephemeral",
    });
    assert.equal(lastMsg.content[0].cache_control, undefined);
    // Usage normalized to total input; cache reads/writes surfaced.
    assert.equal(res.usage.inputTokens, 120);
    assert.equal(res.usage.cachedInputTokens, 90);
    assert.equal(res.usage.cacheWriteInputTokens, 20);
    // Response thinking blocks + served model surfaced.
    assert.equal(res.servedModel, "served-model-id");
    assert.deepEqual(res.content[0], { type: "thinking", thinking: "planning", signature: "sig2" });
  });
});

test("google: thought signatures echoed back with function calls; thought parts skipped", async () => {
  const reply = {
    modelVersion: "gemini-3-pro-001",
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: "internal reasoning summary" },
            { functionCall: { name: "bash", args: { command: "ls" } }, thoughtSignature: "tsig" },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 3,
      thoughtsTokenCount: 2,
      cachedContentTokenCount: 6,
    },
  };
  await withFetchStub([reply, reply], async (captured) => {
    const p = new GoogleProvider("https://gen.example.invalid", "k");
    const first = await p.chat({
      ...BASE_REQ,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    // Thought-summary part is not surfaced as model text.
    assert.equal(first.content.some((b) => b.type === "text"), false);
    const call = first.content.find((b) => b.type === "tool_use");
    assert.ok(call && call.type === "tool_use");
    assert.equal(call.thoughtSignature, "tsig");
    assert.equal(first.servedModel, "gemini-3-pro-001");
    // Reasoning tokens counted as output; implicit-cache reads surfaced.
    assert.equal(first.usage.outputTokens, 5);
    assert.equal(first.usage.cachedInputTokens, 6);

    // Replay the tool_use turn: the signature must ride on the part.
    await p.chat({
      ...BASE_REQ,
      toolChoice: "none",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: "out" }],
        },
      ],
    });
    const body = captured[1];
    const modelParts = body.contents[1].parts;
    assert.equal(modelParts[0].thoughtSignature, "tsig");
    assert.deepEqual(modelParts[0].functionCall, { name: "bash", args: { command: "ls" } });
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "NONE" } });
    assert.equal(body.generationConfig.temperature, undefined);
  });
});

test("openai: direct api.openai.com uses the Responses API; temperature omitted, tool_choice none forwarded", async () => {
  const reply = {
    model: "gpt-5.5-served",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 7 },
    },
  };
  await withFetchStub([reply], async (captured) => {
    const p = new OpenAIProvider("https://api.openai.com/v1", "k");
    const res = await p.chat({
      ...BASE_REQ,
      toolChoice: "none",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    const body = captured[0];
    // Responses wire format: instructions + input items, not messages.
    assert.equal(body.messages, undefined);
    assert.equal(body.instructions, "sys");
    assert.deepEqual(body.input[0], { role: "user", content: [{ type: "input_text", text: "go" }] });
    assert.equal(body.temperature, undefined);
    assert.equal(body.tool_choice, "none");
    assert.equal(body.max_output_tokens, 100);
    // Stateless: nothing stored provider-side; reasoning comes back encrypted.
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    // Flat tool defs, non-strict (plain JSON Schema tools).
    assert.equal(body.tools[0].name, "bash");
    assert.equal(body.tools[0].strict, false);
    assert.equal(res.stopReason, "end_turn");
    assert.deepEqual(res.content, [{ type: "text", text: "ok" }]);
    assert.equal(res.servedModel, "gpt-5.5-served");
    // Automatic prompt caching: cached subset surfaced for cost accounting.
    assert.equal(res.usage.inputTokens, 10);
    assert.equal(res.usage.cachedInputTokens, 7);
  });
});

test("openai responses: reasoning + function_call items replayed verbatim; tool results become function_call_output", async () => {
  const reply = {
    model: "gpt-5.5-served",
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  await withFetchStub([reply, reply], async (captured) => {
    const p = new OpenAIProvider("https://api.openai.com/v1", "k");
    const first = await p.chat({
      ...BASE_REQ,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    assert.equal(first.stopReason, "tool_use");
    const call = first.content.find((b) => b.type === "tool_use");
    assert.ok(call && call.type === "tool_use");
    // The block id is call_id — what function_call_output must reference.
    assert.equal(call.id, "call_1");
    assert.deepEqual(call.input, { command: "ls" });

    // Replay the tool_use turn.
    await p.chat({
      ...BASE_REQ,
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: "out" }],
        },
      ],
    });
    const body = captured[1];
    // Reasoning item verbatim (encrypted content intact), then its
    // function_call with original ids, then the tool output.
    assert.deepEqual(body.input[1], reply.output[0]);
    assert.deepEqual(body.input[2], reply.output[1]);
    assert.deepEqual(body.input[3], {
      type: "function_call_output",
      call_id: "call_1",
      output: "out",
    });
  });
});

test("openai chat: Moonshot reasoning state and direct cache usage survive replay", async () => {
  const reply = {
    model: "kimi-k2.7-code",
    choices: [
      {
        message: {
          content: null,
          reasoning_content: "opaque reasoning state",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80 },
  };
  await withFetchStub([reply, reply], async (captured) => {
    const p = new OpenAIProvider("https://api.moonshot.ai/v1", "k");
    const first = await p.chat({
      ...BASE_REQ,
      model: "kimi-k2.7-code",
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });
    assert.deepEqual(first.content[0], {
      type: "chat_reasoning",
      reasoningContent: "opaque reasoning state",
    });
    assert.equal(first.usage.cachedInputTokens, 80);

    const call = first.content.find((b) => b.type === "tool_use");
    assert.ok(call && call.type === "tool_use");
    await p.chat({
      ...BASE_REQ,
      model: "kimi-k2.7-code",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: "out" }],
        },
      ],
    });
    const replayed = captured[1].messages[2];
    assert.equal(replayed.role, "assistant");
    assert.equal(replayed.reasoning_content, "opaque reasoning state");
    assert.equal(replayed.content, null);
    assert.equal(replayed.tool_calls[0].id, "call_1");
  });
});

test("registry: Kimi K3 routes directly through Moonshot and normalizes every effort tier to max", () => {
  const route = getModel("kimi-k3");
  assert.equal(route.provider_model_id, "kimi-k3");
  assert.equal(route.base_url, "https://api.moonshot.ai/v1");
  assert.equal(route.base_url_env, "MOONSHOT_BASE_URL");
  assert.equal(route.api_key_env, "MOONSHOT_API_KEY");

  for (const tier of ["low", "medium", "high", "xhigh"] as const) {
    const model = getModel("kimi-k3");
    setReasoningEffort(model, tier);
    assert.equal(model.reasoning_effort, tier, "result metadata keeps the requested generic tier");
    assert.equal(nativeReasoningEffortOf(model), "max", "the wire value uses benchmark max");
  }
});

test("reasoning effort mapped to each provider's native control; omitted = nothing sent", async () => {
  const eff: ChatRequest = {
    ...BASE_REQ,
    reasoningEffort: "xhigh",
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  };
  // Anthropic: output_config.effort alongside adaptive thinking.
  await withFetchStub([{ content: [], stop_reason: "end_turn", usage: {} }], async (captured) => {
    await new AnthropicProvider("https://api.example.invalid", "k").chat({
      ...eff,
      thinking: "adaptive",
    });
    assert.deepEqual(captured[0].thinking, { type: "adaptive" });
    assert.deepEqual(captured[0].output_config, { effort: "xhigh" });
  });
  const OPENAI_CHAT_REPLY = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} };
  const OPENAI_RESPONSES_REPLY = { status: "completed", output: [], usage: {} };
  // Direct OpenAI (Responses API): reasoning.effort.
  await withFetchStub([OPENAI_RESPONSES_REPLY], async (captured) => {
    await new OpenAIProvider("https://api.openai.com/v1", "k").chat(eff);
    assert.deepEqual(captured[0].reasoning, { effort: "xhigh" });
    assert.equal(captured[0].reasoning_effort, undefined);
  });
  // OpenRouter: unified reasoning.effort.
  await withFetchStub([OPENAI_CHAT_REPLY], async (captured) => {
    await new OpenAIProvider("https://openrouter.ai/api/v1", "k").chat(eff);
    assert.deepEqual(captured[0].reasoning, { effort: "xhigh" });
    assert.equal(captured[0].reasoning_effort, undefined);
  });
  // Gemini: thinkingLevel — xhigh clamps to HIGH (no xhigh tier).
  await withFetchStub(
    [{ candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: {} }],
    async (captured) => {
      await new GoogleProvider("https://gen.example.invalid", "k").chat(eff);
      assert.deepEqual(captured[0].generationConfig.thinkingConfig, { thinkingLevel: "HIGH" });
    },
  );
  await withFetchStub(
    [{ candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: {} }],
    async (captured) => {
      await new GoogleProvider("https://gen.example.invalid", "k").chat({
        ...eff,
        reasoningEffort: "medium",
      });
      assert.deepEqual(captured[0].generationConfig.thinkingConfig, { thinkingLevel: "MEDIUM" });
    },
  );
  // Effort omitted → provider default: no effort field on any provider.
  await withFetchStub([OPENAI_RESPONSES_REPLY], async (captured) => {
    await new OpenAIProvider("https://api.openai.com/v1", "k").chat({
      ...eff,
      reasoningEffort: undefined,
    });
    assert.equal(captured[0].reasoning, undefined);
  });
});

test("costOf: cached reads/writes billed at cached rates; exact provider cost wins", async () => {
  const { costOf } = await import("../src/providers/index.js");
  const model = {
    pricing: {
      input_per_mtok: 5,
      output_per_mtok: 30,
      input_cache_read_per_mtok: 0.5,
      input_cache_write_per_mtok: 6.25,
    },
  } as any;
  // All fresh: 1M x $5.
  assert.equal(costOf(model, { inputTokens: 1_000_000, outputTokens: 0 }), 5);
  // 900k of the 1M cached: 100k x $5 + 900k x $0.50 = $0.95 — not $5.
  assert.ok(
    Math.abs(
      costOf(model, { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 }) -
        0.95,
    ) < 1e-9,
  );
  // Cache writes billed at the write premium: 100k x $5 + 900k x $6.25 = $6.125.
  assert.ok(
    Math.abs(
      costOf(model, { inputTokens: 1_000_000, cacheWriteInputTokens: 900_000, outputTokens: 0 }) -
        6.125,
    ) < 1e-9,
  );
  // No cached rate in the table → cached tokens fall back to list price.
  const flat = { pricing: { input_per_mtok: 5, output_per_mtok: 30 } } as any;
  assert.equal(
    costOf(flat, { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 }),
    5,
  );
  // Provider-reported exact cost (OpenRouter) always takes precedence.
  assert.equal(costOf(model, { inputTokens: 123, outputTokens: 456, costUsd: 0.42 }), 0.42);
});

test("fetchJson: retries explicit 429/529 rejections, then succeeds", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(429, { "retry-after": "0" });
      res.end("rate limited");
      return;
    }
    if (hits === 2) {
      res.writeHead(529);
      res.end("overloaded");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    const json = await fetchJson("test", `http://127.0.0.1:${port}/x`, {}, {});
    assert.deepEqual(json, { ok: true });
    assert.equal(hits, 3);
  } finally {
    server.close();
  }
});

test("fetchJson: ambiguous 5xx responses are not replayed", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(504);
    res.end("upstream timeout");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    await assert.rejects(
      () => fetchJson("test", `http://127.0.0.1:${port}/x`, {}, {}),
      (e: unknown) => e instanceof ProviderHttpError && e.status === 504,
    );
    assert.equal(hits, 1, "an ambiguous upstream outcome must not be retried");
  } finally {
    server.close();
  }
});

test("fetchJson: non-retryable 400 throws immediately", async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(400);
    res.end("bad request");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    await assert.rejects(
      () => fetchJson("test", `http://127.0.0.1:${port}/x`, {}, {}),
      (e: unknown) => e instanceof ProviderHttpError && e.status === 400,
    );
    assert.equal(hits, 1, "400 must not be retried");
  } finally {
    server.close();
  }
});

test("fetchJson: transport failures are not replayed when the request outcome is unknown", async () => {
  let hits = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    hits += 1;
    throw new TypeError("fetch failed");
  }) as any;
  try {
    await assert.rejects(
      () => fetchJson("test", "https://example.invalid", {}, {}, 1000, 5),
      (e: unknown) =>
        e instanceof ProviderTransportError &&
        /not retried.*duplicate provider work or charges/.test(e.message) &&
        e.cause instanceof TypeError,
    );
    assert.equal(hits, 1, "an ambiguous POST outcome must never be retried automatically");
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchJson: retries transient errors embedded in HTTP 200 bodies", async () => {
  let hits = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    hits += 1;
    const body =
      hits === 1
        ? { error: { type: "server_error", message: "try again" } }
        : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
  try {
    assert.deepEqual(await fetchJson("test", "https://example.invalid", {}, {}, 1000, 2), {
      ok: true,
    });
    assert.equal(hits, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test("fetchJson: terminal errors embedded in HTTP 200 bodies fail immediately", async () => {
  let hits = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    hits += 1;
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "bad input" } }),
      { status: 200 },
    );
  }) as any;
  try {
    await assert.rejects(
      () => fetchJson("test", "https://example.invalid", {}, {}),
      (e: unknown) => e instanceof ProviderHttpError && e.status === 400,
    );
    assert.equal(hits, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("image blocks: mapped to each provider's native form; string content preserved without images", async () => {
  const IMG = { type: "image" as const, media_type: "image/jpeg", data: "QUJD" };
  const msgs = (withImage: boolean): ChatRequest["messages"] => [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "report" },
        ...(withImage ? [{ type: "text" as const, text: "Screenshot:" }, IMG] : []),
      ],
    },
  ];

  // Anthropic: base64 image source block; a trailing image carries the
  // cache breakpoint.
  const anthReply = {
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  await withFetchStub([anthReply], async (captured) => {
    const p = new AnthropicProvider("https://api.example.invalid", "k");
    await p.chat({ ...BASE_REQ, messages: msgs(true) });
    const blocks = captured[0].messages[2].content;
    assert.equal(blocks[0].type, "tool_result");
    const img = blocks.find((b: any) => b.type === "image");
    assert.deepEqual(img.source, { type: "base64", media_type: "image/jpeg", data: "QUJD" });
    assert.deepEqual(blocks[blocks.length - 1].cache_control, { type: "ephemeral" });
  });

  // OpenAI Responses: user input_image item with a data URL (images cannot
  // ride inside function_call_output).
  const respReply = { status: "completed", output: [], usage: {} };
  await withFetchStub([respReply], async (captured) => {
    const p = new OpenAIProvider("https://api.openai.com/v1", "k");
    await p.chat({ ...BASE_REQ, messages: msgs(true) });
    const imgItem = captured[0].input.find(
      (it: any) =>
        Array.isArray(it.content) && it.content.some((c: any) => c.type === "input_image"),
    );
    assert.ok(imgItem, "expected a user input_image item");
    assert.equal(imgItem.content[0].image_url, "data:image/jpeg;base64,QUJD");
  });

  // Chat Completions (OpenRouter): multimodal parts array with images,
  // plain string content without.
  const ccReply = {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  await withFetchStub([ccReply, ccReply], async (captured) => {
    const p = new OpenAIProvider("https://openrouter.ai/api/v1", "k");
    await p.chat({ ...BASE_REQ, messages: msgs(true) });
    const userMsg = captured[0].messages[captured[0].messages.length - 1];
    assert.equal(userMsg.role, "user");
    assert.ok(Array.isArray(userMsg.content));
    assert.deepEqual(userMsg.content[1], {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,QUJD" },
    });

    await p.chat({ ...BASE_REQ, messages: msgs(false) });
    const noImg = captured[1].messages;
    assert.equal(noImg[1].content, "go"); // text-only user content stays a string
    assert.equal(noImg[noImg.length - 1].role, "tool");
    assert.equal(typeof noImg[noImg.length - 1].content, "string");
  });

  // Gemini: inlineData part in the same user turn, after the
  // functionResponse (images cannot ride inside functionResponse).
  const gemReply = {
    candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  };
  await withFetchStub([gemReply], async (captured) => {
    const p = new GoogleProvider("https://gen.example.invalid", "k");
    await p.chat({ ...BASE_REQ, messages: msgs(true) });
    const parts = captured[0].contents[2].parts;
    assert.ok(parts[0].functionResponse, "functionResponse must lead the turn");
    const inline = parts.find((x: any) => x.inlineData);
    assert.deepEqual(inline.inlineData, { mimeType: "image/jpeg", data: "QUJD" });
  });
});

test("registry: model ids and names carry no credential or billing metadata", () => {
  const registry = loadRegistry();
  const ids = registry.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const model of registry) {
    assert.doesNotMatch(model.id, /oauth|subscription|api[-_.]?key/i);
    assert.doesNotMatch(model.name, /oauth|subscription|api key|authentication/i);
  }
  assert.throws(() => getModel("gpt-5.5-oauth"), /unknown model id/);
});

test("isTerminalHttpError: only bounded rate-limit and overload rejections are retryable", () => {
  // Non-retryable statuses (e.g. context-length-exceeded) — throw at once.
  assert.equal(isTerminalHttpError(400, null, "context_length_exceeded"), true);
  assert.equal(isTerminalHttpError(401, null, "unauthorized"), true);
  // Hard usage/quota cap wearing a 429 — do NOT retry.
  assert.equal(isTerminalHttpError(429, null, '{"error":{"code":"insufficient_quota"}}'), true);
  assert.equal(isTerminalHttpError(429, null, "You have hit your usage limit"), true);
  // 429 telling us to wait longer than we ever would — futile to retry.
  assert.equal(isTerminalHttpError(429, "3600", "slow down"), true);
  // Transient per-minute rate limit — SHOULD still retry (not terminal).
  assert.equal(isTerminalHttpError(429, "20", "Rate limit reached, try again in 20s"), false);
  assert.equal(isTerminalHttpError(529, null, "overloaded"), false);
  // A generic upstream failure has an ambiguous completion/billing outcome.
  assert.equal(isTerminalHttpError(503, null, "service unavailable"), true);
});
