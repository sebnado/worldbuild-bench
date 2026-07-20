import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, AgentCheckpoint } from "../src/agent/agent.js";
import { BudgetTracker } from "../src/agent/budget.js";
import { Transcript } from "../src/agent/transcript.js";
import { ModelEntry } from "../src/providers/index.js";
import {
  ChatRequest,
  ChatResponse,
  Provider,
  ToolResultBlock,
} from "../src/providers/types.js";
import { readFileTool, writeFileTool } from "../src/tools/fs.js";
import { bashTool } from "../src/tools/bash.js";
import { spawnAgentTool } from "../src/tools/spawn_agent.js";

const MODEL: ModelEntry = {
  id: "mock-model",
  name: "Mock Model",
  provider: "anthropic",
  provider_model_id: "mock-1",
  base_url: "https://example.invalid",
  api_key_env: "MOCK_KEY",
  pricing: { input_per_mtok: 1, output_per_mtok: 2 },
};

const USAGE = { inputTokens: 100, outputTokens: 50 };

/** Scripted provider: routes each request to a handler and records requests. */
class MockProvider implements Provider {
  readonly name = "mock";
  requests: ChatRequest[] = [];
  constructor(private handler: (req: ChatRequest, callIndex: number) => Promise<ChatResponse>) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const idx = this.requests.length;
    this.requests.push(JSON.parse(JSON.stringify(req)));
    return this.handler(req, idx);
  }
}

function firstUserText(req: ChatRequest): string {
  const first = req.messages[0];
  const block = first.content.find((b) => b.type === "text");
  return block && "text" in block ? block.text : "";
}

function lastMessageToolResults(req: ChatRequest): ToolResultBlock[] {
  const last = req.messages[req.messages.length - 1];
  return last.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
}

/** True when the last message is the finish-confirmation nudge (a tool-less
 * reply draws exactly one before the agent ends on the second in a row). */
function lastMessageIsNudge(req: ChatRequest): boolean {
  const last = req.messages[req.messages.length - 1];
  return (
    last.role === "user" &&
    lastMessageToolResults(req).length === 0 &&
    last.content.some((b) => b.type === "text" && /no tool calls/.test(b.text))
  );
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-"));
}

function makeAgent(provider: Provider, workspace: string, budget: BudgetTracker, tools = [
  bashTool,
  readFileTool,
  writeFileTool,
  spawnAgentTool,
]) {
  return new Agent({
    provider,
    model: MODEL,
    tools,
    workspace,
    budget,
    transcript: new Transcript(null, true),
  });
}

test("agent loop: tool call -> result -> second turn -> finish", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (req, idx) => {
    if (idx === 0) {
      return {
        content: [
          { type: "text", text: "writing the file" },
          {
            type: "tool_use",
            id: "call_1",
            name: "write_file",
            input: { path: "hello.txt", content: "hi there" },
          },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    if (idx === 1) {
      // Second turn: the tool result must have been fed back.
      const results = lastMessageToolResults(req);
      assert.equal(results.length, 1);
      assert.equal(results[0].tool_use_id, "call_1");
      assert.match(results[0].content, /wrote hello\.txt/);
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: USAGE };
    }
    // Third turn: the tool-less reply drew the finish-confirmation nudge;
    // confirming with a second tool-less reply ends the run.
    assert.ok(lastMessageIsNudge(req), "expected the finish-confirmation nudge");
    return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: USAGE };
  });

  const agent = makeAgent(provider, workspace, new BudgetTracker());
  const result = await agent.run("write hello.txt");

  assert.equal(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8"), "hi there");
  assert.equal(result.finalText, "done");
  assert.equal(result.stats.turns, 3);
  assert.equal(result.stats.toolCalls.write_file, 1);
  assert.equal(result.stats.budgetExhausted, null);
  // Cost: 3 calls x (100 in x $1/M + 50 out x $2/M) = 3 x $0.0002
  assert.ok(Math.abs(result.stats.costUsd - 0.0006) < 1e-9);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("finish nudge: a narrated stop resumes work; only two tool-less replies in a row end the run", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (req, idx) => {
    if (idx === 0) {
      // The observed failure: the model narrates its next action and stops
      // without issuing the tool call.
      return {
        content: [{ type: "text", text: "Let me now test the full integrated game." }],
        stopReason: "end_turn",
        usage: USAGE,
      };
    }
    if (idx === 1) {
      // The nudge arrives; the model resumes with a real tool call.
      assert.ok(lastMessageIsNudge(req), "first tool-less reply must draw the nudge");
      return {
        content: [{ type: "tool_use", id: "b1", name: "bash", input: { command: "true" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    if (idx === 2) {
      // Work done; a tool-less reply again — the nudge flag was reset by
      // the tool call, so this draws a fresh nudge, not the end.
      assert.equal(lastMessageToolResults(req).length, 1);
      return {
        content: [{ type: "text", text: "All done: built and tested." }],
        stopReason: "end_turn",
        usage: USAGE,
      };
    }
    // Second consecutive tool-less reply ends the run.
    assert.ok(lastMessageIsNudge(req));
    return {
      content: [{ type: "text", text: "Final summary: game built." }],
      stopReason: "end_turn",
      usage: USAGE,
    };
  });

  const agent = makeAgent(provider, workspace, new BudgetTracker());
  const result = await agent.run("build the game");

  assert.equal(provider.requests.length, 4);
  // The nudge reply is shorter than the pre-nudge summary, so the richer
  // pre-nudge text is kept as the final text.
  assert.equal(result.finalText, "All done: built and tested.");
  assert.equal(result.stats.turns, 4);
  assert.equal(result.stats.toolCalls.bash, 1);
  assert.equal(result.stats.budgetExhausted, null);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("finish nudge: budget death while awaiting confirmation ends the run without a wrap-up call", async () => {
  const workspace = makeWorkspace();
  const SUMMARY = "Fixed resetTrack(): generated samples are preserved; node --check passed.";
  const PRICED_MODEL: ModelEntry = {
    ...MODEL,
    pricing: { input_per_mtok: 0, output_per_mtok: 1000 }, // $0.001/token out
  };
  const provider = new MockProvider(async (req, idx) => {
    // Every call consumes its full output reservation, so spend is exact.
    const usage = { inputTokens: 0, outputTokens: req.maxTokens };
    if (idx === 0) {
      return {
        content: [{ type: "tool_use", id: "b1", name: "bash", input: { command: "true" } }],
        stopReason: "tool_use",
        usage,
      };
    }
    if (idx === 1) {
      return { content: [{ type: "text", text: SUMMARY }], stopReason: "end_turn", usage };
    }
    throw new Error("must not be called: no budget remains for the confirmation");
  });

  // $2.50 cap with $1 worst-case calls: two full calls spend $2, and the
  // remaining $0.50 cannot cover even the 512-token reservation floor for
  // the nudge-confirmation call — the summary must stand as final text.
  const agent = new Agent({
    provider,
    model: PRICED_MODEL,
    tools: [bashTool, readFileTool, writeFileTool, spawnAgentTool],
    workspace,
    budget: new BudgetTracker({ maxUsd: 2.5 }),
    transcript: new Transcript(null, true),
    maxTokensPerTurn: 1000,
  });
  const result = await agent.run("fix the bug");

  assert.equal(provider.requests.length, 2, "no wrap-up call after the unaffordable nudge");
  assert.equal(result.finalText, SUMMARY);
  assert.match(result.stats.budgetExhausted ?? "", /before the finish-confirmation/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("finish nudge: a terse confirmation does not replace the real summary as final text", async () => {
  const workspace = makeWorkspace();
  const SUMMARY = "Built the full game: track, AI opponents, HUD, restart — all validated.";
  const provider = new MockProvider(async (req, idx) => {
    if (idx === 0) {
      return { content: [{ type: "text", text: SUMMARY }], stopReason: "end_turn", usage: USAGE };
    }
    assert.ok(lastMessageIsNudge(req));
    return {
      content: [{ type: "text", text: "Confirmed — done." }],
      stopReason: "end_turn",
      usage: USAGE,
    };
  });
  const agent = makeAgent(provider, workspace, new BudgetTracker());
  const result = await agent.run("build the game");
  assert.equal(provider.requests.length, 2);
  assert.equal(result.finalText, SUMMARY);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("budget exhaustion: one final wrap-up turn with tool calls forbidden", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (req, idx) => {
    if (idx === 0) {
      assert.ok(req.tools.length > 0, "first turn should have tools enabled");
      assert.equal(req.toolChoice, undefined, "normal turns must not restrict tool choice");
      return {
        content: [
          { type: "tool_use", id: "c1", name: "bash", input: { command: "echo hi" } },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    // Wrap-up turn: the tool defs are STILL sent (providers reject
    // tool_use/tool_result history without them) but calls are forbidden
    // via toolChoice, and the budget text rides in the SAME user message
    // as the tool results (no consecutive same-role messages).
    assert.ok(req.tools.length > 0, "wrap-up turn must still send tool definitions");
    assert.equal(req.toolChoice, "none", "wrap-up turn must forbid tool calls");
    const last = req.messages[req.messages.length - 1];
    assert.equal(last.role, "user");
    const results = last.content.filter((b) => b.type === "tool_result");
    assert.equal(results.length, 1, "tool results must be in the wrap-up message");
    const text = last.content.find((b) => b.type === "text");
    assert.ok(text && "text" in text && /Budget exhausted/.test(text.text));
    for (let i = 1; i < req.messages.length; i++) {
      assert.notEqual(
        req.messages[i].role,
        req.messages[i - 1].role,
        "roles must alternate — some providers reject consecutive same-role messages",
      );
    }
    return {
      content: [{ type: "text", text: "wrapped up" }],
      stopReason: "end_turn",
      usage: USAGE,
    };
  });

  const agent = makeAgent(provider, workspace, new BudgetTracker({ maxTurns: 1 }));
  const result = await agent.run("loop forever");

  assert.equal(provider.requests.length, 2);
  assert.equal(result.finalText, "wrapped up");
  assert.match(result.stats.budgetExhausted ?? "", /turn budget exhausted/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("spawn_agent: parallel children, results fed back, spend rolls up", async () => {
  const workspace = makeWorkspace();
  const childWindows: Record<string, { start: number; end: number }> = {};

  const provider = new MockProvider(async (req) => {
    const task = firstUserText(req);
    if (task.startsWith("child")) {
      if (lastMessageIsNudge(req)) {
        // Confirm the finish; don't re-record the timing window.
        return {
          content: [{ type: "text", text: `${task} finished` }],
          stopReason: "end_turn",
          usage: USAGE,
        };
      }
      const w = { start: Date.now(), end: 0 };
      childWindows[task] = w;
      await new Promise((r) => setTimeout(r, 150));
      w.end = Date.now();
      return {
        content: [{ type: "text", text: `${task} finished` }],
        stopReason: "end_turn",
        usage: USAGE,
      };
    }
    // Root agent.
    if (lastMessageIsNudge(req)) {
      return { content: [{ type: "text", text: "root done" }], stopReason: "end_turn", usage: USAGE };
    }
    const results = lastMessageToolResults(req);
    if (results.length === 0) {
      return {
        content: [
          { type: "tool_use", id: "s1", name: "spawn_agent", input: { task: "child one" } },
          { type: "tool_use", id: "s2", name: "spawn_agent", input: { task: "child two" } },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    assert.equal(results.length, 2);
    assert.match(results.map((r) => r.content).join("|"), /child one finished/);
    assert.match(results.map((r) => r.content).join("|"), /child two finished/);
    return {
      content: [{ type: "text", text: "root done" }],
      stopReason: "end_turn",
      usage: USAGE,
    };
  });

  const agent = makeAgent(provider, workspace, new BudgetTracker());
  const result = await agent.run("build the thing");

  assert.equal(result.finalText, "root done");
  assert.equal(result.stats.subagentsSpawned, 2);
  // 7 provider calls: root turn 1, two children + their finish nudges,
  // root turn 2 + its finish nudge — tokens, turns, and tool-call counts
  // all roll up into the root stats.
  assert.equal(provider.requests.length, 7);
  assert.equal(result.stats.inputTokens, 700);
  assert.equal(result.stats.outputTokens, 350);
  assert.equal(result.stats.turns, 7);
  assert.equal(result.stats.toolCalls.spawn_agent, 2);
  // Concurrency: the two children's provider calls must overlap in time.
  const a = childWindows["child one"];
  const b = childWindows["child two"];
  assert.ok(a && b, "both children ran");
  assert.ok(
    a.start < b.end && b.start < a.end,
    `children did not overlap: A=${JSON.stringify(a)} B=${JSON.stringify(b)}`,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("turn budget is shared: child turns exhaust the root's maxTurns", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (req) => {
    const task = firstUserText(req);
    if (task.startsWith("child")) {
      const last = req.messages[req.messages.length - 1];
      const wrapping = last.content.some(
        (b) => b.type === "text" && /Budget exhausted/.test(b.text),
      );
      if (wrapping) {
        return {
          content: [{ type: "text", text: "child wrapped" }],
          stopReason: "end_turn",
          usage: USAGE,
        };
      }
      // The child tries to work forever — only the budget can stop it.
      return {
        content: [
          { type: "tool_use", id: `c${req.messages.length}`, name: "bash", input: { command: "true" } },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    const results = lastMessageToolResults(req);
    if (results.length === 0) {
      return {
        content: [
          { type: "tool_use", id: "s1", name: "spawn_agent", input: { task: "child task" } },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    return { content: [{ type: "text", text: "root done" }], stopReason: "end_turn", usage: USAGE };
  });

  const budget = new BudgetTracker({ maxTurns: 2 });
  const agent = makeAgent(provider, workspace, budget);
  const result = await agent.run("delegate everything");

  // Root turn 1 + child turn 1 hit the shared cap of 2; then the child gets
  // one wrap-up turn and the root gets one: exactly 4 provider calls —
  // subagent turns count against the same shared tracker.
  assert.equal(provider.requests.length, 4);
  assert.ok(budget.turns >= 2, `root tracker must count child turns (got ${budget.turns})`);
  assert.match(result.stats.budgetExhausted ?? "", /turn budget exhausted/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("subagent accounting rolls up recursively into root stats", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (req) => {
    const task = firstUserText(req);
    const results = lastMessageToolResults(req);
    if (task.startsWith("grand")) {
      if (results.length > 0 || lastMessageIsNudge(req)) {
        return { content: [{ type: "text", text: "grand done" }], stopReason: "end_turn", usage: USAGE };
      }
      return {
        content: [{ type: "tool_use", id: "g1", name: "bash", input: { command: "true" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    if (task.startsWith("child")) {
      if (results.length > 0 || lastMessageIsNudge(req)) {
        return { content: [{ type: "text", text: "child done" }], stopReason: "end_turn", usage: USAGE };
      }
      return {
        content: [
          { type: "tool_use", id: "cb", name: "bash", input: { command: "true" } },
          { type: "tool_use", id: "cs", name: "spawn_agent", input: { task: "grand task" } },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    // Root.
    if (results.length === 0 && !lastMessageIsNudge(req)) {
      return {
        content: [{ type: "tool_use", id: "r1", name: "spawn_agent", input: { task: "child task" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    return { content: [{ type: "text", text: "root done" }], stopReason: "end_turn", usage: USAGE };
  });

  const agent = makeAgent(provider, workspace, new BudgetTracker());
  const result = await agent.run("build it");

  // root(2+nudge) + child(2+nudge) + grandchild(2+nudge) turns; bash from
  // child + grandchild; spawn_agent from root + child; counts recursively.
  assert.equal(result.finalText, "root done");
  assert.equal(result.stats.turns, 9);
  assert.equal(result.stats.toolCalls.bash, 2);
  assert.equal(result.stats.toolCalls.spawn_agent, 2);
  assert.equal(result.stats.subagentsSpawned, 2);
  assert.equal(result.stats.inputTokens, 900);
  assert.equal(result.stats.outputTokens, 450);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("concurrent subagents cannot overrun the run budget — spend <= maxUsd strictly", async () => {
  const workspace = makeWorkspace();
  // Deterministic costs: input is free, output costs $0.001/token, and the
  // mock always consumes exactly the per-call max_tokens the agent granted.
  // Reservation worst case therefore equals actual cost, so total spend is
  // exactly the sum of the reserved output grants — never above maxUsd.
  const PRICED_MODEL: ModelEntry = {
    ...MODEL,
    pricing: { input_per_mtok: 0, output_per_mtok: 1000 },
  };
  const MAX_USD = 10;
  const CHILDREN = 6;

  const provider = new MockProvider(async (req) => {
    const usage = { inputTokens: 0, outputTokens: req.maxTokens };
    const task = firstUserText(req);
    if (task.startsWith("module")) {
      const last = req.messages[req.messages.length - 1];
      const wrapping = last.content.some(
        (b) => b.type === "text" && /Budget exhausted/.test(b.text),
      );
      if (wrapping) {
        return {
          content: [{ type: "text", text: `${task} wrapped` }],
          stopReason: "end_turn",
          usage,
        };
      }
      // Children try to work forever — only the budget can stop them.
      return {
        content: [
          {
            type: "tool_use",
            id: `c${req.messages.length}`,
            name: "bash",
            input: { command: "true" },
          },
        ],
        stopReason: "tool_use",
        usage,
      };
    }
    // Root: spawn CHILDREN parallel children — all draw on the run's one
    // shared tracker.
    if (lastMessageIsNudge(req)) {
      return { content: [{ type: "text", text: "root done" }], stopReason: "end_turn", usage };
    }
    const results = lastMessageToolResults(req);
    if (results.length === 0) {
      return {
        content: Array.from({ length: CHILDREN }, (_, i) => ({
          type: "tool_use" as const,
          id: `s${i}`,
          name: "spawn_agent",
          input: { task: `module ${i}` },
        })),
        stopReason: "tool_use",
        usage,
      };
    }
    return {
      content: [{ type: "text", text: "root done" }],
      stopReason: "end_turn",
      usage,
    };
  });

  const budget = new BudgetTracker({ maxUsd: MAX_USD });
  const agent = new Agent({
    provider,
    model: PRICED_MODEL,
    tools: [bashTool, readFileTool, writeFileTool, spawnAgentTool],
    workspace,
    budget,
    transcript: new Transcript(null, true),
    maxTokensPerTurn: 1000, // $1 worst case per unclamped call
  });
  const result = await agent.run("build 6 modules in parallel");

  // Every call's cost is exactly its granted max_tokens at $0.001/token.
  const expected = provider.requests.reduce((s, r) => s + r.maxTokens, 0) / 1000;
  assert.ok(
    Math.abs(budget.usedUsd - expected) < 1e-9,
    `budget.usedUsd=${budget.usedUsd} but calls sum to $${expected}`,
  );
  // STRICT invariant: reservation-based budgeting means aggregate spend
  // across all concurrent subagents (including every wrap-up call) can
  // never exceed the cap — no in-flight tolerance.
  assert.ok(
    budget.usedUsd <= MAX_USD + 1e-9,
    `aggregate spend $${budget.usedUsd} exceeded the cap $${MAX_USD}`,
  );
  // And the budget was actually consumed, not starved by over-reservation:
  // spend stops within one worst-case call of the cap.
  assert.ok(
    budget.usedUsd >= MAX_USD - 1,
    `spend $${budget.usedUsd} should have approached the $${MAX_USD} cap`,
  );
  assert.equal(result.stats.subagentsSpawned, CHILDREN);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("reserveCall: clamps output to fit, enforces the floor, settles the difference", () => {
  const pricing = { input_per_mtok: 0, output_per_mtok: 1000 }; // $0.001/token
  const b = new BudgetTracker({ maxUsd: 1 });

  // Worst case $8.192 doesn't fit $1 → clamped to exactly 1000 output tokens.
  const r1 = b.reserveCall(0, 8192, pricing);
  assert.ok(r1);
  assert.equal(r1.maxTokens, 1000);

  // Everything is reserved — even the 512-token floor no longer fits.
  assert.equal(b.reserveCall(0, 8192, pricing), null);

  // Settling with a smaller actual cost releases the difference.
  b.settle(r1, 0.4, 400);
  assert.ok(Math.abs(b.usedUsd - 0.4) < 1e-9);
  const r2 = b.reserveCall(0, 8192, pricing);
  assert.ok(r2);
  assert.equal(r2.maxTokens, 600);
  b.release(r2);

  // Below the 512-token floor → exhausted, unless the caller lowers the
  // floor (the wrap-up turn reserves whatever still fits).
  const b2 = new BudgetTracker({ maxUsd: 0.1 });
  assert.equal(b2.reserveCall(0, 8192, pricing), null);
  const wrap = b2.reserveCall(0, 8192, pricing, 1);
  assert.ok(wrap);
  assert.equal(wrap.maxTokens, 100);

  // Concurrent agents share one tracker: a reservation held by one blocks
  // another from double-booking the same headroom.
  const shared = new BudgetTracker({ maxUsd: 1 });
  const held = shared.reserveCall(0, 1000, pricing);
  assert.ok(held);
  assert.equal(shared.reserveCall(0, 1000, pricing), null);
  shared.release(held);
  assert.ok(shared.reserveCall(0, 1000, pricing, 1));
});

test("wall-clock: fetch timeout capped to remaining wall; near-zero wall skips all calls", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async () => ({
    content: [{ type: "text", text: "hi" }],
    stopReason: "end_turn",
    usage: USAGE,
  }));

  // 30s wall remaining → per-attempt timeout must be remaining + 5s grace,
  // not the 600s default.
  const agent = makeAgent(provider, workspace, new BudgetTracker({ maxWallMs: 30_000 }));
  await agent.run("hello");
  // 2 calls: the tool-less reply draws the finish nudge, then confirms.
  assert.equal(provider.requests.length, 2);
  const t = provider.requests[0].timeoutMs;
  assert.ok(typeof t === "number" && t <= 35_000 && t > 20_000, `timeoutMs=${t}`);

  // Under 5s of wall left → treated as exhausted: no provider call at all.
  const provider2 = new MockProvider(async () => {
    throw new Error("must not be called");
  });
  const agent2 = makeAgent(provider2, workspace, new BudgetTracker({ maxWallMs: 4_000 }));
  const r = await agent2.run("hello");
  assert.equal(provider2.requests.length, 0);
  assert.match(r.stats.budgetExhausted ?? "", /wall-clock/);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("partial stats survive a provider error mid-run", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (req, idx) => {
    if (idx < 2) {
      return {
        content: [
          { type: "tool_use", id: `c${idx}`, name: "bash", input: { command: "true" } },
        ],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    throw new Error("mock HTTP 429: rate limited");
  });

  const budget = new BudgetTracker();
  const agent = makeAgent(provider, workspace, budget);
  await assert.rejects(() => agent.run("work"), /429/);

  // The two successful turns' accounting must survive the abort — this is
  // what runBench records instead of a zeroed stats block.
  const stats = agent.snapshotStats();
  assert.equal(stats.turns, 3); // the failed turn was counted before the call
  assert.equal(stats.inputTokens, 200);
  assert.equal(stats.outputTokens, 100);
  assert.ok(Math.abs(stats.costUsd - 0.0004) < 1e-9);
  assert.equal(stats.toolCalls.bash, 2);
  assert.ok(Math.abs(budget.usedUsd - 0.0004) < 1e-9);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("served model ids are recorded and divergence tolerated", async () => {
  const workspace = makeWorkspace();
  const provider = new MockProvider(async (_req, idx) => ({
    content: [{ type: "text", text: "done" }],
    stopReason: "end_turn",
    usage: USAGE,
    servedModel: idx === 0 ? "mock-1-actually-served" : "mock-1",
  }));
  const agent = makeAgent(provider, workspace, new BudgetTracker());
  const result = await agent.run("hello");
  // Call 2 is the finish-nudge confirmation, served as the requested id —
  // every distinct served id is recorded.
  assert.deepEqual(result.stats.servedModels, ["mock-1-actually-served", "mock-1"]);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("checkpoint: tool rounds are persisted incrementally and finish at clean boundaries", async () => {
  const workspace = makeWorkspace();
  const checkpoints: AgentCheckpoint[] = [];
  const provider = new MockProvider(async (_req, idx) => {
    if (idx === 0) {
      return {
        content: [{ type: "tool_use", id: "c1", name: "write_file", input: { path: "a.txt", content: "one" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    if (idx === 1) {
      return {
        content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "true" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    // Tool-less reply → nudge, then confirm; neither is a checkpoint boundary.
    return { content: [{ type: "text", text: "first pass complete" }], stopReason: "end_turn", usage: USAGE };
  });
  const agent = new Agent({
    provider,
    model: MODEL,
    tools: [bashTool, readFileTool, writeFileTool, spawnAgentTool],
    workspace,
    budget: new BudgetTracker(),
    transcript: new Transcript(null, true),
    onCheckpoint: (cp) => checkpoints.push(structuredClone(cp)),
  });
  await agent.run("build");

  // Each tool round records pending, running, completed, then clean state.
  const clean = checkpoints.filter((cp) => cp.inFlightToolCalls === undefined);
  assert.equal(clean.length, 2);
  assert.ok(
    checkpoints.some((cp) => cp.inFlightToolCalls?.[0]?.status === "pending"),
    "assistant tool calls must be durable before execution starts",
  );
  assert.ok(checkpoints.some((cp) => cp.inFlightToolCalls?.[0]?.status === "running"));
  assert.ok(checkpoints.some((cp) => cp.inFlightToolCalls?.[0]?.status === "completed"));
  const last = clean[clean.length - 1];
  const lastMsg = last.messages[last.messages.length - 1];
  assert.equal(lastMsg.role, "user", "a checkpoint must end on a resumable user message");
  assert.ok(
    lastMsg.content.some((b) => b.type === "tool_result"),
    "the trailing user message must carry tool results",
  );
  assert.equal(last.stats.turns, 2);
  assert.equal(last.stats.toolCalls.write_file, 1);
  assert.equal(last.stats.toolCalls.bash, 1);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("checkpoint: budget exhaustion still snapshots the final tool round, clean", async () => {
  const workspace = makeWorkspace();
  const checkpoints: AgentCheckpoint[] = [];
  // $0.001/token out; each call consumes its full 1000-token grant → $1/turn.
  const PRICED_MODEL: ModelEntry = {
    ...MODEL,
    pricing: { input_per_mtok: 0, output_per_mtok: 1000 },
  };
  const provider = new MockProvider(async (req, idx) => {
    const usage = { inputTokens: 0, outputTokens: req.maxTokens };
    if (idx === 0) {
      return {
        content: [{ type: "tool_use", id: "c1", name: "write_file", input: { path: "a.txt", content: "one" } }],
        stopReason: "tool_use",
        usage,
      };
    }
    return { content: [{ type: "text", text: "wrapped up" }], stopReason: "end_turn", usage };
  });
  // $1 cap: turn 0 spends exactly $1, so budget.exceeded() trips right after the
  // tool round — the path that previously skipped the checkpoint.
  const agent = new Agent({
    provider,
    model: PRICED_MODEL,
    tools: [bashTool, readFileTool, writeFileTool, spawnAgentTool],
    workspace,
    budget: new BudgetTracker({ maxUsd: 1 }),
    transcript: new Transcript(null, true),
    maxTokensPerTurn: 1000,
    onCheckpoint: (cp) => checkpoints.push(structuredClone(cp)),
  });
  const result = await agent.run("build");

  assert.match(result.stats.budgetExhausted ?? "", /cost budget/);
  // The one tool round reached a clean checkpoint despite the budget tripping on it.
  const clean = checkpoints.filter((cp) => cp.inFlightToolCalls === undefined);
  assert.equal(clean.length, 1, "the final tool round must be resumable");
  const cp = clean[0];
  const last = cp.messages[cp.messages.length - 1];
  assert.equal(last.role, "user");
  assert.ok(last.content.some((b) => b.type === "tool_result"), "snapshot carries the tool results");
  // ...and the snapshot is clean — no wrap-up scaffolding leaked into it, so a
  // resume continues from real work, not a "budget exhausted, summarize" prompt.
  assert.ok(
    !last.content.some((b) => b.type === "text" && /Budget exhausted/.test(b.text)),
    "the checkpoint must not contain wrap-up text",
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("resume: replays the exact checkpoint history and preserves cumulative stats", async () => {
  const workspace = makeWorkspace();

  // Segment 1: one tool round, then the run stops (as if budget-exhausted).
  const checkpoints: AgentCheckpoint[] = [];
  const seg1 = new MockProvider(async (_req, idx) => {
    if (idx === 0) {
      return {
        content: [{ type: "tool_use", id: "c1", name: "write_file", input: { path: "a.txt", content: "one" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    return { content: [{ type: "text", text: "stopped early" }], stopReason: "end_turn", usage: USAGE };
  });
  const agent1 = new Agent({
    provider: seg1,
    model: MODEL,
    tools: [bashTool, readFileTool, writeFileTool, spawnAgentTool],
    workspace,
    budget: new BudgetTracker(),
    transcript: new Transcript(null, true),
    onCheckpoint: (cp) => checkpoints.push(structuredClone(cp)),
  });
  await agent1.run("build the game");
  const snapshot = checkpoints[checkpoints.length - 1];
  assert.ok(snapshot, "segment 1 must produce a checkpoint");

  // Segment 2: resume from the snapshot with a fresh budget.
  let sawPriorHistory = false;
  let sawExactHistory = false;
  const seg2 = new MockProvider(async (req, idx) => {
    if (idx === 0) {
      sawPriorHistory = req.messages.some(
        (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use" && b.id === "c1"),
      );
      sawExactHistory = JSON.stringify(req.messages) === JSON.stringify(snapshot.messages);
      return {
        content: [{ type: "tool_use", id: "c2", name: "bash", input: { command: "true" } }],
        stopReason: "tool_use",
        usage: USAGE,
      };
    }
    return { content: [{ type: "text", text: "finished after resume" }], stopReason: "end_turn", usage: USAGE };
  });
  const agent2 = new Agent({
    provider: seg2,
    model: MODEL,
    tools: [bashTool, readFileTool, writeFileTool, spawnAgentTool],
    workspace,
    budget: new BudgetTracker(),
    transcript: new Transcript(null, true),
    resumeState: snapshot,
  });
  const resumed = await agent2.run("THIS INITIAL MESSAGE IS IGNORED ON RESUME");

  assert.ok(sawPriorHistory, "resumed conversation must replay the prior history");
  assert.ok(sawExactHistory, "resume must not inject or alter conversation messages");
  // The ignored initial message must not have started a fresh conversation.
  assert.ok(
    !firstUserText(seg2.requests[0]).includes("IGNORED"),
    "resume must not seed the ignored initial message",
  );
  assert.equal(resumed.finalText, "finished after resume");
  // Segment 1 checkpoint captured 1 turn; the resume adds exactly 3 (bash round,
  // the tool-less reply that draws the nudge, then the confirming reply). Exact
  // totals — not just ">" — so any double-counting of a segment would fail here.
  assert.equal(snapshot.stats.turns, 1);
  assert.equal(resumed.stats.turns, 4, "cumulative = 1 prior + 3 resumed, counted once");
  assert.equal(resumed.stats.inputTokens, 400, "100 prior + 3 x 100");
  assert.equal(resumed.stats.outputTokens, 200, "50 prior + 3 x 50");
  // 4 turns x (100 in x $1/M + 50 out x $2/M) = 4 x $0.0002.
  assert.ok(Math.abs(resumed.stats.costUsd - 0.0008) < 1e-9, "cost cumulative, not doubled");
  assert.equal(resumed.stats.toolCalls.write_file, 1, "prior tool-call counts carry forward");
  assert.equal(resumed.stats.toolCalls.bash, 1, "new tool calls stack on top");
  assert.equal(resumed.stats.budgetExhausted, null, "the fresh window resets the exhaustion flag");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("resume: interrupted running tools become results and are never replayed", async () => {
  const { z } = await import("zod");
  const workspace = makeWorkspace();
  let executions = 0;
  const dangerousTool = {
    def: {
      name: "dangerous_append",
      description: "non-idempotent test tool",
      inputSchema: { type: "object", properties: {} },
    },
    schema: z.object({}),
    execute: async () => {
      executions += 1;
      return "appended";
    },
  };
  const call = {
    type: "tool_use" as const,
    id: "uncertain_1",
    name: "dangerous_append",
    input: {},
  };
  const snapshot: AgentCheckpoint = {
    messages: [
      { role: "user", content: [{ type: "text", text: "build" }] },
      { role: "assistant", content: [call] },
    ],
    finalText: "working",
    stats: {
      turns: 1,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      costUsd: 0.0002,
      toolCalls: { dangerous_append: 1 },
      subagentsSpawned: 0,
      imagesSent: 0,
      budgetExhausted: null,
      servedModels: [],
    },
    ownTurns: 1,
    directChildren: 4,
    tasks: [{ title: "Inspect interrupted work", status: "in_progress" }],
    inFlightToolCalls: [{ call, status: "running" }],
  };
  const provider = new MockProvider(async (req, idx) => {
    if (idx === 0) {
      const last = req.messages.at(-1);
      assert.equal(last?.role, "user");
      const result = last?.content.find((block) => block.type === "tool_result");
      assert.ok(result && result.type === "tool_result");
      assert.equal(result.tool_use_id, call.id);
      assert.equal(result.is_error, true);
      assert.match(result.content, /side effects may already exist/i);
    } else {
      assert.ok(lastMessageIsNudge(req));
    }
    return { content: [{ type: "text", text: "recovered safely" }], stopReason: "end_turn", usage: USAGE };
  });
  const agent = new Agent({
    provider,
    model: MODEL,
    tools: [dangerousTool],
    workspace,
    budget: new BudgetTracker(),
    transcript: new Transcript(null, true),
    resumeState: snapshot,
  });
  await agent.run("");

  assert.equal(executions, 0, "an uncertain operation must never run automatically");
  const runtime = agent.snapshotRuntimeState();
  assert.equal(runtime.directChildren, 4, "child labels continue after resume");
  assert.deepEqual(runtime.tasks, snapshot.tasks, "runtime task state survives resume");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("spawn_agent: rejected beyond max depth", async () => {
  const out = await spawnAgentTool.execute(
    { task: "go deeper" },
    {
      workspace: "/tmp",
      depth: 2,
      budget: new BudgetTracker(),
      transcript: new Transcript(null, true),
      spawn: async () => "should not be called",
    },
  );
  assert.match(out, /maximum subagent depth/);
});


test("tool images: shown to vision models after the tool_result, dropped for text-only", async () => {
  const { z } = await import("zod");
  const screenshotTool = {
    def: {
      name: "fake_test_game",
      description: "returns a report plus a screenshot",
      inputSchema: { type: "object", properties: {} },
    },
    schema: z.object({}),
    execute: async () => ({
      text: '{"ok":true}',
      images: [{ media_type: "image/jpeg", data: "QUJD", label: "Playtest screenshot:" }],
    }),
  };

  const run = async (vision: boolean) => {
    const workspace = makeWorkspace();
    let sawImage = false;
    const provider = new MockProvider(async (req, idx) => {
      if (idx === 0) {
        return {
          content: [{ type: "tool_use", id: "c1", name: "fake_test_game", input: {} }],
          stopReason: "tool_use",
          usage: USAGE,
        };
      }
      if (idx === 1) {
        const last = req.messages[req.messages.length - 1];
        // tool_result blocks lead the user message regardless of images.
        assert.equal(last.content[0].type, "tool_result");
        sawImage = last.content.some((b) => b.type === "image");
        if (sawImage) {
          const imgIdx = last.content.findIndex((b) => b.type === "image");
          const caption = last.content[imgIdx - 1];
          assert.ok(
            caption.type === "text" && /screenshot/i.test(caption.text),
            "caption text must precede the image",
          );
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: USAGE };
      }
      return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: USAGE };
    });
    const agent = new Agent({
      provider,
      model: { ...MODEL, ...(vision ? { vision: true } : {}) },
      tools: [screenshotTool],
      workspace,
      budget: new BudgetTracker(),
      transcript: new Transcript(null, true),
    });
    const result = await agent.run("test the game");
    return { sawImage, imagesSent: result.stats.imagesSent };
  };

  const sighted = await run(true);
  assert.equal(sighted.sawImage, true, "vision model must receive the image");
  assert.equal(sighted.imagesSent, 1);

  const blind = await run(false);
  assert.equal(blind.sawImage, false, "text-only model must not receive the image");
  assert.equal(blind.imagesSent, 0);
});
