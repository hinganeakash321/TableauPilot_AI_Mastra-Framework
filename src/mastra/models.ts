/**
 * Model configuration for TableauPilot AI.
 *
 * Wires the Anthropic-compatible gateway defined in `.env` into an AI SDK
 * language model that Mastra agents consume. Handles three environment realities:
 *
 *  1. A dynamic token via `ANTHROPIC_API_KEY_HELPER` (a command that prints the
 *     token) instead of a static `ANTHROPIC_API_KEY`.
 *  2. A corporate CA bundle (`ANTHROPIC_CA_CERT`) required to trust the gateway.
 *  3. An OpenRouter fallback provider.
 *
 * Secrets are never logged. The resolved token is cached in memory only and
 * refreshed transparently on a 401 (spec sections 7, 8, 70).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { MastraLanguageModel } from "@mastra/core/agent";
import { loadEnv, resolveProvider, type Env } from "../config/env.js";
import { logger } from "../config/logger.js";

/** In-memory cache of the resolved Anthropic token. Never persisted. */
let tokenCache: string | null = null;

/**
 * Resolves the Anthropic API token. Prefers a static key; otherwise executes the
 * configured helper command and caches its output. The value is never logged.
 */
function resolveAnthropicToken(env: Env, forceRefresh = false): string {
  if (!forceRefresh && tokenCache) return tokenCache;

  if (env.ANTHROPIC_API_KEY) {
    tokenCache = env.ANTHROPIC_API_KEY;
    return tokenCache;
  }

  if (env.ANTHROPIC_API_KEY_HELPER) {
    const parts = env.ANTHROPIC_API_KEY_HELPER.trim().split(/\s+/);
    const cmd = parts[0]!;
    const args = parts.slice(1);
    try {
      const out = execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: 15_000,
      }).trim();
      if (!out) {
        throw new Error("API key helper returned empty output");
      }
      tokenCache = out;
      logger.debug("Resolved Anthropic token via key helper", {
        tokenLength: out.length,
      });
      return tokenCache;
    } catch (err) {
      throw new Error(
        `Failed to resolve Anthropic token via ANTHROPIC_API_KEY_HELPER: ${
          (err as Error).message
        }`,
      );
    }
  }

  throw new Error(
    "No Anthropic credentials available: set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_HELPER.",
  );
}

/** Clears the cached token, forcing a fresh resolution on next use. */
export function clearTokenCache(): void {
  tokenCache = null;
}

/**
 * Builds a `fetch` implementation for the Anthropic gateway. It:
 *  - injects the (possibly self-signed) corporate CA via an undici dispatcher,
 *  - overrides the `x-api-key` header with the freshly resolved token,
 *  - retries once on 401 after refreshing the token.
 */
function buildAnthropicFetch(env: Env): typeof globalThis.fetch {
  let dispatcher: UndiciAgent | undefined;
  if (env.ANTHROPIC_CA_CERT) {
    try {
      const ca = readFileSync(env.ANTHROPIC_CA_CERT, "utf8");
      dispatcher = new UndiciAgent({ connect: { ca } });
      logger.info("Loaded corporate CA bundle for Anthropic gateway");
    } catch (err) {
      logger.warn("Failed to load ANTHROPIC_CA_CERT; proceeding without it", {
        message: (err as Error).message,
      });
    }
  }

  const doFetch = async (
    input: string | URL | Request,
    init: RequestInit | undefined,
    token: string,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("x-api-key", token);
    headers.delete("authorization");
    const merged: Record<string, unknown> = {
      ...(init ?? {}),
      headers,
    };
    if (dispatcher) merged.dispatcher = dispatcher;
    // undici's fetch accepts the `dispatcher` option; cast to satisfy TS types.
    return (await undiciFetch(
      input as unknown as string,
      merged as never,
    )) as unknown as Response;
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    let token = resolveAnthropicToken(env);
    let res = await doFetch(input, init, token);
    if (res.status === 401) {
      logger.warn("Anthropic gateway returned 401; refreshing token once");
      clearTokenCache();
      token = resolveAnthropicToken(env, true);
      res = await doFetch(input, init, token);
    }
    return res;
  }) as typeof globalThis.fetch;
}

let modelCache: MastraLanguageModel | null = null;

/**
 * Returns the configured language model for the TableauPilot agent. The provider
 * is chosen from the environment (Anthropic gateway preferred, OpenRouter
 * fallback). The model instance is memoized.
 */
export function getModel(): MastraLanguageModel {
  if (modelCache) return modelCache;

  const env = loadEnv();
  const provider = resolveProvider(env);

  if (provider === "anthropic") {
    const anthropic = createAnthropic({
      baseURL: normalizeAnthropicBaseUrl(env.ANTHROPIC_BASE_URL!),
      // The real token is injected per-request by the custom fetch; this
      // placeholder keeps the SDK happy and is never sent as-is.
      apiKey: "managed-by-fetch",
      fetch: buildAnthropicFetch(env),
    });
    logger.info("Model configured", {
      provider: "anthropic",
      model: env.LLM_MODEL,
    });
    // Anthropic provider (spec v3) is wrapped by Mastra via version detection.
    // The cast bridges a patch-level @ai-sdk/provider structural mismatch.
    const model = anthropic(env.LLM_MODEL) as unknown as MastraLanguageModel;
    modelCache = model;
    return model;
  }

  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: env.OPENROUTER_BASE_URL,
    apiKey: env.OPENROUTER_API_KEY!,
  });
  logger.info("Model configured", {
    provider: "openrouter",
    model: env.LLM_MODEL,
  });
  const model = openrouter(env.LLM_MODEL) as unknown as MastraLanguageModel;
  modelCache = model;
  return model;
}

/**
 * The AI SDK's Anthropic provider builds request URLs as `${baseURL}/messages`
 * (it only auto-adds `/v1` for the public api.anthropic.com host). So for a
 * custom gateway we must pass a baseURL that already ends with `/v1`, otherwise
 * requests hit `${gateway}/messages` and the gateway returns 404.
 */
function normalizeAnthropicBaseUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  return u.endsWith("/v1") ? u : `${u}/v1`;
}
