/**
 * Centralized, Zod-validated environment configuration.
 *
 * The `.env` file is the single source of truth for secrets (spec section 7).
 * This module reads and validates environment variables and exposes a strongly
 * typed `env` object. It NEVER logs secret values.
 */

import { z } from "zod";
import { logger, type LogLevel } from "./logger.js";

/**
 * Raw environment schema. Most fields are optional because different providers
 * and deployment scenarios require different subsets. Cross-field requirements
 * are enforced after parsing in {@link loadEnv}.
 */
const EnvSchema = z.object({
  // Provider selection
  LLM_PROVIDER: z
    .enum(["anthropic", "openrouter"])
    .default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-opus-4-8"),

  // Anthropic gateway
  ANTHROPIC_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY_HELPER: z.string().min(1).optional(),
  ANTHROPIC_CA_CERT: z.string().min(1).optional(),

  // OpenRouter fallback
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1"),

  // Tableau
  TABLEAU_VERSION: z.string().default("2026.1"),

  // App
  WORKSPACE_PATH: z.string().default("./workspace"),
  LOG_LEVEL: z
    .enum(["DEBUG", "INFO", "WARN", "ERROR"])
    .default("INFO"),

  // Optional Tableau Cloud defaults (never required; entered at deploy time)
  TABLEAU_CLOUD_URL: z.string().url().optional(),
  TABLEAU_SITE_CONTENT_URL: z.string().optional(),
  TABLEAU_PAT_NAME: z.string().optional(),
  TABLEAU_PAT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export type ResolvedProvider = "anthropic" | "openrouter";

let cached: Env | null = null;

/**
 * Parses and validates `process.env`. Throws a readable error if validation
 * fails. The result is cached for subsequent calls.
 */
export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        "See .env.example for the expected variables.",
    );
  }

  const env = parsed.data;
  logger.setLevel(env.LOG_LEVEL as LogLevel);
  cached = env;

  logger.info("Environment loaded", {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL,
    tableauVersion: env.TABLEAU_VERSION,
    anthropicBaseUrlConfigured: Boolean(env.ANTHROPIC_BASE_URL),
    anthropicAuth: env.ANTHROPIC_API_KEY
      ? "static-key"
      : env.ANTHROPIC_API_KEY_HELPER
        ? "key-helper"
        : "none",
    caCertConfigured: Boolean(env.ANTHROPIC_CA_CERT),
    openRouterConfigured: Boolean(env.OPENROUTER_API_KEY),
  });

  return env;
}

/**
 * Determines which provider to use based on configuration and availability.
 * Prefers the explicitly selected provider, falling back when its config is
 * incomplete.
 */
export function resolveProvider(env: Env): ResolvedProvider {
  const anthropicUsable =
    Boolean(env.ANTHROPIC_BASE_URL) &&
    (Boolean(env.ANTHROPIC_API_KEY) || Boolean(env.ANTHROPIC_API_KEY_HELPER));
  const openRouterUsable = Boolean(env.OPENROUTER_API_KEY);

  if (env.LLM_PROVIDER === "anthropic") {
    if (anthropicUsable) return "anthropic";
    if (openRouterUsable) {
      logger.warn(
        "Anthropic gateway not fully configured; falling back to OpenRouter.",
      );
      return "openrouter";
    }
  }

  if (env.LLM_PROVIDER === "openrouter") {
    if (openRouterUsable) return "openrouter";
    if (anthropicUsable) {
      logger.warn(
        "OpenRouter not configured; falling back to Anthropic gateway.",
      );
      return "anthropic";
    }
  }

  throw new Error(
    "No usable LLM provider configured. Set an Anthropic gateway " +
      "(ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_HELPER) " +
      "or OPENROUTER_API_KEY in your .env file.",
  );
}
