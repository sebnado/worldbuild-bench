/** Provider-neutral chat types. Adapters normalize wire formats to these. */

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  /** Provider call id (synthesized when the provider has none). */
  id: string;
  name: string;
  input: unknown;
  /** Gemini 3 thought signature — opaque, must be echoed with the call. */
  thoughtSignature?: string;
  /** OpenAI Responses function_call item — replayed so ids stay paired with reasoning. */
  responsesItem?: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Base64 image for vision models (user messages only). Dropped for text-only
 * models. Adapters map to Anthropic image / OpenAI input_image / Gemini inlineData.
 */
export interface ImageBlock {
  type: "image";
  media_type: string;
  data: string;
}

/** Anthropic thinking — replayed verbatim on the Anthropic path only. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/** Anthropic redacted thinking — opaque, replayed verbatim. */
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

/**
 * OpenAI Responses reasoning item — opaque, replayed on the direct-OpenAI path.
 * Carries encrypted_content because store:false runs keep no provider-side state.
 */
export interface ResponsesReasoningBlock {
  type: "openai_reasoning";
  item: unknown;
}

/**
 * OpenAI-compatible Chat Completions reasoning state. Providers such as
 * Moonshot require this field to be echoed verbatim in later tool-call turns.
 */
export interface ChatReasoningBlock {
  type: "chat_reasoning";
  reasoningContent: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ResponsesReasoningBlock
  | ChatReasoningBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens: number;
  /** Omitted by default — several reasoning APIs reject non-default temperature. */
  temperature?: number;
  /**
   * "none" forbids tool calls while keeping tool defs (some providers reject
   * history that contains tool blocks when `tools` is absent).
   */
  toolChoice?: "auto" | "none";
  thinking?: "adaptive";
  /**
   * Mapped per provider: OpenAI/OpenRouter reasoning.effort, Anthropic
   * output_config.effort, Gemini thinkingLevel (no xhigh — clamps to HIGH).
   */
  reasoningEffort?: string;
  /** Per-attempt fetch timeout; agent caps this to remaining wall-clock. */
  timeoutMs?: number;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface Usage {
  /** Total input tokens, including cached (all adapters normalize to this). */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Anthropic cache_creation — billed at a premium write rate. */
  cacheWriteInputTokens?: number;
  /** Provider-reported cost when available (e.g. OpenRouter). */
  costUsd?: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "other";

export interface ChatResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
  /** Model id the provider reports it actually served (silent-fallback detection). */
  servedModel?: string;
}

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    body: string,
  ) {
    super(`${provider} HTTP ${status}: ${body.slice(0, 2000)}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * The connection failed without an HTTP response. The provider may still have
 * accepted and completed the request, so automatically replaying it could
 * duplicate work and charges.
 */
export class ProviderTransportError extends Error {
  constructor(
    public provider: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${provider} transport failure; request outcome is unknown and was not retried ` +
        `to avoid duplicate provider work or charges: ${detail}`,
      { cause },
    );
    this.name = "ProviderTransportError";
  }
}

// These statuses indicate rejection before inference. Generic timeouts and 5xx
// responses can arrive after upstream work completed, so replaying them is not
// safe without an idempotency contract shared by every supported provider.
const RETRYABLE_STATUSES = new Set([429, 529]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return base * (0.5 + Math.random() * 0.5);
}

/** Parse retry-after (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
}

const MAX_RETRY_WAIT_MS = 60_000;

/**
 * Hard usage/quota caps wear a retryable status (often 429) but won't clear
 * soon — fail fast instead of burning backoff attempts.
 */
const QUOTA_BODY_RE =
  /insufficient_quota|quota exceeded|exceeded your (current )?quota|usage limit|usage cap|plan limit|monthly limit|weekly limit|billing_hard_limit_reached/i;

/** Error `type`s in a 2xx body that retrying cannot clear. */
const TERMINAL_BODY_ERROR_RE = /invalid_request|authentication|permission|not_found|invalid_api_key/i;

/** True when a non-2xx must not be retried (non-retryable status, long retry-after, or hard quota). */
export function isTerminalHttpError(
  status: number,
  retryAfterHeader: string | null,
  body: string,
): boolean {
  if (!RETRYABLE_STATUSES.has(status)) return true;
  const ra = retryAfterMs(retryAfterHeader);
  if (ra !== null && ra > MAX_RETRY_WAIT_MS) return true;
  return QUOTA_BODY_RE.test(body);
}

/**
 * POST JSON. Explicit rate-limit/overload rejections and provider error payloads
 * are retried with backoff.
 * Transport failures are never replayed automatically: once a POST is handed
 * to fetch, there is no portable way to know whether the provider accepted it.
 */
export async function fetchJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 600_000,
  maxAttempts = 5,
): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        // AbortSignal.timeout rejects non-integer delays; wall remaining can be fractional.
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      });
      text = await res.text();
    } catch (e) {
      throw new ProviderTransportError(provider, e);
    }
    if (!res.ok) {
      const err = new ProviderHttpError(provider, res.status, text);
      if (
        isTerminalHttpError(res.status, res.headers.get("retry-after"), text) ||
        attempt === maxAttempts
      )
        throw err;
      lastError = err;
      const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
      await sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
      continue;
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderHttpError(provider, res.status, `invalid JSON body: ${text.slice(0, 500)}`);
    }
    // Some providers (e.g. Moonshot) report transient faults as HTTP 200 with an
    // error payload and no choices. Left alone these parse into an empty turn,
    // which the caller would then append to history as an empty assistant
    // message — permanently poisoning the conversation for strict providers.
    if (json?.error) {
      const terminal = TERMINAL_BODY_ERROR_RE.test(text) || QUOTA_BODY_RE.test(text);
      const err = new ProviderHttpError(provider, terminal ? 400 : 503, text);
      if (terminal || attempt === maxAttempts) throw err;
      lastError = err;
      await sleep(backoffMs(attempt));
      continue;
    }
    return json;
  }
  throw lastError;
}
