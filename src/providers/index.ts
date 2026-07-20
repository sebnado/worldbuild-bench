import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAIProvider } from "./openai.js";
import { Provider, ReasoningEffort, Usage } from "./types.js";
import { packageRoot } from "../util/paths.js";

const PricingSchema = z.object({
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  /** Cached prompt reads; falls back to input_per_mtok when omitted. */
  input_cache_read_per_mtok: z.number().nonnegative().optional(),
  /** Premium cache writes (Anthropic cache_creation). */
  input_cache_write_per_mtok: z.number().nonnegative().optional(),
});

const credentialBearingModelId = /(^|[-_.])(oauth|subscription|api[-_.]?key)([-_.]|$)/i;
const credentialBearingModelName = /\b(oauth|subscription|api[ -]?key|authentication)\b/i;

const ModelEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .refine((id) => !credentialBearingModelId.test(id), {
        message: "model ids identify models, not credential or billing paths",
      }),
    name: z
      .string()
      .min(1)
      .refine((name) => !credentialBearingModelName.test(name), {
        message: "model names identify models, not credential or billing paths",
      }),
    provider: z.enum(["anthropic", "openai", "google"]),
    provider_model_id: z.string().min(1),
    base_url: z.string().url(),
    base_url_env: z.string().optional(),
    api_key_env: z.string().min(1),
    pricing: PricingSchema,
    /** Anthropic adaptive thinking; omit when unsupported. */
    thinking: z.enum(["adaptive"]).optional(),
    /** Accepts image input (test_game screenshots). Verify against provider docs. */
    vision: z.boolean().optional(),
    /** Reasoning-effort tier; omit for provider default. */
    reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    /** Optional generic-tier -> provider-native effort mapping/capability declaration. */
    reasoning_effort_map: z
      .object({
        low: z.string().min(1).optional(),
        medium: z.string().min(1).optional(),
        high: z.string().min(1).optional(),
        xhigh: z.string().min(1).optional(),
      })
      .optional(),
    /** Per-turn output cap (reasoning tokens count on some providers). */
    max_output_tokens: z.number().int().positive().optional(),
  })
  .superRefine((model, ctx) => {
    if (!model.reasoning_effort_map) return;
    if (Object.keys(model.reasoning_effort_map).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasoning_effort_map"],
        message: "reasoning_effort_map must declare at least one supported generic tier",
      });
    }
    if (model.reasoning_effort && !model.reasoning_effort_map[model.reasoning_effort]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasoning_effort"],
        message: "default reasoning_effort must be present in reasoning_effort_map",
      });
    }
  });

const RegistrySchema = z
  .object({
    models: z.array(ModelEntrySchema),
  })
  .superRefine(({ models }, ctx) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models", index, "id"],
          message: `duplicate model id ${JSON.stringify(model.id)}`,
        });
      }
      seen.add(model.id);
    }
  });

export type ModelEntry = z.infer<typeof ModelEntrySchema>;

/** Credential-neutral identity of the endpoint used for a provider request. */
export interface ProviderRouteIdentity {
  provider: ModelEntry["provider"];
  providerModelId: string;
  baseUrl: string;
  apiKeyEnv: string;
}

export function loadRegistry(file?: string): ModelEntry[] {
  const p = file ?? path.join(packageRoot(), "models.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return RegistrySchema.parse(raw).models;
}

export function getModel(id: string, file?: string): ModelEntry {
  const models = loadRegistry(file);
  const m = models.find((x) => x.id === id);
  if (!m) {
    const known = models.map((x) => x.id).join(", ");
    throw new Error(`unknown model id "${id}". Known models: ${known}`);
  }
  return m;
}

/** Apply and validate a generic effort override against model capabilities. */
export function setReasoningEffort(model: ModelEntry, effort: ReasoningEffort | undefined): void {
  if (!effort) return;
  if (model.reasoning_effort_map && !model.reasoning_effort_map[effort]) {
    const supported = Object.keys(model.reasoning_effort_map).join("|");
    throw new Error(
      `${model.id} does not support --effort ${effort}; supported tier${supported.includes("|") ? "s" : ""}: ${supported}`,
    );
  }
  model.reasoning_effort = effort;
}

/** Provider-native effort string for the model's selected generic tier. */
export function nativeReasoningEffortOf(model: ModelEntry): string | undefined {
  const effort = model.reasoning_effort;
  if (!effort) return undefined;
  return model.reasoning_effort_map?.[effort] ?? effort;
}

/** Resolve environment-based routing once so checkpoints can pin the same endpoint. */
export function providerRouteOf(model: ModelEntry): ProviderRouteIdentity {
  const configuredBaseUrl =
    (model.base_url_env ? process.env[model.base_url_env] : undefined) ?? model.base_url;
  return {
    provider: model.provider,
    providerModelId: model.provider_model_id,
    baseUrl: configuredBaseUrl.replace(/\/+$/, ""),
    apiKeyEnv: model.api_key_env,
  };
}

export function providerFor(
  model: ModelEntry,
  route: ProviderRouteIdentity = providerRouteOf(model),
): Provider {
  const apiKey = process.env[route.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `missing API key: set ${route.apiKeyEnv} in your environment (see .env.example)`,
    );
  }
  switch (route.provider) {
    case "anthropic":
      return new AnthropicProvider(route.baseUrl, apiKey);
    case "openai":
      return new OpenAIProvider(route.baseUrl, apiKey);
    case "google":
      return new GoogleProvider(route.baseUrl, apiKey);
  }
}

/** Prefer provider-reported cost; else list price with cache read/write rates. */
export function costOf(model: ModelEntry, usage: Usage): number {
  if (typeof usage.costUsd === "number") return usage.costUsd;
  return referenceCostOf(model, usage);
}

/** List-price cost from the registry table (ignores provider-reported costUsd). */
export function referenceCostOf(model: ModelEntry, usage: Usage): number {
  const p = model.pricing;
  const cachedRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cachedRead - cacheWrite);
  return (
    (fresh * p.input_per_mtok +
      cachedRead * (p.input_cache_read_per_mtok ?? p.input_per_mtok) +
      cacheWrite * (p.input_cache_write_per_mtok ?? p.input_per_mtok) +
      usage.outputTokens * p.output_per_mtok) /
    1_000_000
  );
}
