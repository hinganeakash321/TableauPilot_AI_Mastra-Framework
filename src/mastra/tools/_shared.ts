/**
 * Shared helpers for Mastra tools: structured error mapping and result wrapping.
 * Every tool returns a discriminated `{ ok }` result so failures are structured
 * rather than thrown across the tool boundary (spec section 20, rules.md 5).
 */

import { z } from "zod";
import {
  StructuredErrorSchema,
  type ErrorCode,
  type StructuredError,
} from "../schemas/common.js";
import { TableauCloudError } from "../../tableau/cloud/tableauCloudService.js";

/** Builds a discriminated success/failure output schema for a payload. */
export function toolResult<T extends z.ZodTypeAny>(payload: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: payload }),
    z.object({ ok: z.literal(false), error: StructuredErrorSchema }),
  ]);
}

/** Maps an arbitrary thrown value into a StructuredError. */
export function toStructuredError(
  err: unknown,
  fallbackCode: ErrorCode = "UNKNOWN",
): StructuredError {
  if (err instanceof TableauCloudError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof Error) {
    return { code: fallbackCode, message: err.message };
  }
  return { code: fallbackCode, message: String(err) };
}

/** Runs a producer and wraps the outcome in a tool result. */
export async function runTool<T>(
  producer: () => Promise<T> | T,
  fallbackCode: ErrorCode = "UNKNOWN",
): Promise<{ ok: true; data: T } | { ok: false; error: StructuredError }> {
  try {
    return { ok: true, data: await producer() };
  } catch (err) {
    return { ok: false, error: toStructuredError(err, fallbackCode) };
  }
}
