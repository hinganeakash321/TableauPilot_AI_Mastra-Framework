/**
 * Datasource-related schemas: connection info, datasource info, and the all
 * important DatasourceLock (spec sections 34, 87).
 */

import { z } from "zod";
import { ConnectionModeSchema } from "./common.js";

/** A single named connection inside a (federated) datasource. */
export const ConnectionInfoSchema = z.object({
  name: z.string(),
  caption: z.string().optional(),
  /** Tableau connection class, e.g. `excel-direct`, `hyper`, `sqlproxy`. */
  connectionClass: z.string(),
  server: z.string().optional(),
  /** Original filename for file-based connections (never a secret). */
  filename: z.string().optional(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;

/** Metadata about a datasource discovered in the workbook. */
export const DatasourceInfoSchema = z.object({
  /** Tableau internal datasource id, e.g. `federated.10qd...`. */
  id: z.string(),
  /** Human-friendly caption. */
  name: z.string(),
  caption: z.string().optional(),
  /** Top-level connection class (usually `federated`). */
  connectionType: z.string(),
  connectionMode: ConnectionModeSchema,
  connections: z.array(ConnectionInfoSchema).default([]),
  /** Whether the datasource has an embedded extract (.hyper). */
  hasExtract: z.boolean().default(false),
  /** Table/relation names present in the datasource. */
  tables: z.array(z.string()).default([]),
});
export type DatasourceInfo = z.infer<typeof DatasourceInfoSchema>;

/**
 * The locked datasource. Once set, every worksheet operation must reference it.
 * This is the single source of truth (spec sections 29-35, 87).
 */
export const DatasourceLockSchema = z.object({
  workbookPath: z.string(),
  datasourceName: z.string(),
  datasourceId: z.string(),
  connectionType: z.string(),
  connectionMode: ConnectionModeSchema,
  locked: z.literal(true),
});
export type DatasourceLock = z.infer<typeof DatasourceLockSchema>;
