/**
 * Shared Zod enums and primitives used across TableauPilot schemas.
 */

import { z } from "zod";

/** Tableau column data types as they appear in TWB XML. */
export const DataTypeSchema = z.enum([
  "string",
  "integer",
  "real",
  "date",
  "datetime",
  "boolean",
  "table", // internal object-model tables (ignored for worksheet building)
]);
export type DataType = z.infer<typeof DataTypeSchema>;

/** Field role. */
export const FieldRoleSchema = z.enum(["dimension", "measure"]);
export type FieldRole = z.infer<typeof FieldRoleSchema>;

/** Aggregations supported for measures (and count/countd for dimensions). */
export const AggregationSchema = z.enum([
  "none",
  "sum",
  "avg",
  "count",
  "countd",
  "min",
  "max",
  "median",
]);
export type Aggregation = z.infer<typeof AggregationSchema>;

/** Date derivations (date parts / truncations) for date dimensions. */
export const DateDerivationSchema = z.enum([
  "none",
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "weekday",
  "hour",
  "minute",
]);
export type DateDerivation = z.infer<typeof DateDerivationSchema>;

/** Connection mode: extract vs live. Switching between these is forbidden. */
export const ConnectionModeSchema = z.enum(["live", "extract"]);
export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;

/** Stable error codes returned by tools/engine (spec rules.md section 5). */
export const ErrorCodeSchema = z.enum([
  "DATASOURCE_LOCK_VIOLATION",
  "DATASOURCE_NOT_FOUND",
  "MULTIPLE_DATASOURCES",
  "FIELD_NOT_FOUND",
  "UNSUPPORTED_CHART_TYPE",
  "DASHBOARD_OUT_OF_SCOPE",
  "TWBX_INVALID",
  "TWB_XML_INVALID",
  "WORKSHEET_COLLISION",
  "DEPLOYMENT_AUTH_FAILED",
  "DEPLOYMENT_FAILED",
  "VALIDATION_FAILED",
  "IO_ERROR",
  "UNKNOWN",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Structured error object used across tool boundaries. */
export const StructuredErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  suggestions: z.array(z.string()).optional(),
});
export type StructuredError = z.infer<typeof StructuredErrorSchema>;

/** Generic validation result reused throughout the engine. */
export const ValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(StructuredErrorSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

/**
 * Helper to build a discriminated success/failure result schema for a payload.
 */
export function resultSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: payload }),
    z.object({ ok: z.literal(false), error: StructuredErrorSchema }),
  ]);
}
