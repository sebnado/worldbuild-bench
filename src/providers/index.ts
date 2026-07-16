import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAIProvider } from "./openai.js";
import { Provider, Usage } from "./types.js";
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

const ModelEntrySchema = z.object({
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
  /** Per-turn output cap (reasoning tokens count on some providers). */
  max_output_tokens: z.number().int().positive().optional(),
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

export function providerFor(model: ModelEntry): Provider {
  const baseURL =
    (model.base_url_env ? process.env[model.base_url_env] : undefined) ?? model.base_url;
  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(
      `missing API key: set ${model.api_key_env} in your environment (see .env.example)`,
    );
  }
  switch (model.provider) {
    case "anthropic":
      return new AnthropicProvider(baseURL, apiKey);
    case "openai":
      return new OpenAIProvider(baseURL, apiKey);
    case "google":
      return new GoogleProvider(baseURL, apiKey);
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
