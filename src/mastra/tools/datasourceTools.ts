/**
 * Datasource tools (spec section 19 - DATASOURCE).
 *
 * Enforce the single-source-of-truth datasource lock. A datasource is never
 * created, replaced, reconnected, or switched between live/extract (spec 30).
 */

import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { resolveLock } from "../../tableau/lock.js";
import { openTwbx } from "../../tableau/twbx.js";
import { validateLockAgainstWorkbook } from "../../tableau/compiler/workbookCompiler.js";
import {
  DatasourceLockSchema,
  DatasourceInfoSchema,
  ValidationResultSchema,
  WorksheetFilterSpecSchema,
} from "../schemas/index.js";
import { runTool, toolResult } from "./_shared.js";

const PathInput = z.object({ twbxPath: z.string() });

export const validateDatasource = createTool({
  id: "validateDatasource",
  description:
    "Verify a datasource id exists in the workbook and return its metadata.",
  inputSchema: PathInput.extend({ datasourceId: z.string() }),
  outputSchema: toolResult(
    z.object({ exists: z.boolean(), datasource: DatasourceInfoSchema.optional() }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const ds = r.datasources.find((d) => d.id === inputData.datasourceId);
      return { exists: Boolean(ds), datasource: ds };
    }, "DATASOURCE_NOT_FOUND"),
});

export const lockDatasource = createTool({
  id: "lockDatasource",
  description:
    "Lock the workbook's datasource as the single source of truth. Auto-locks " +
    "when there is exactly one; requires selectedDatasourceId when several exist. " +
    "Never creates a datasource.",
  inputSchema: PathInput.extend({ selectedDatasourceId: z.string().optional() }),
  outputSchema: toolResult(
    z.object({
      lock: DatasourceLockSchema.optional(),
      requiresSelection: z.boolean(),
      datasources: z.array(DatasourceInfoSchema),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const outcome = resolveLock(
        r,
        inputData.twbxPath,
        inputData.selectedDatasourceId,
      );
      if (outcome.ok) {
        return {
          lock: outcome.lock,
          requiresSelection: false,
          datasources: r.datasources,
        };
      }
      if (outcome.error.code === "MULTIPLE_DATASOURCES") {
        return {
          requiresSelection: true,
          datasources: outcome.datasources,
        };
      }
      throw new Error(outcome.error.message);
    }, "DATASOURCE_NOT_FOUND"),
});

export const validateDatasourceLock = createTool({
  id: "validateDatasourceLock",
  description:
    "Validate that a lock matches the workbook's datasource before any " +
    "modification. Returns DATASOURCE_LOCK_VIOLATION on mismatch.",
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
  }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(async () => {
      const opened = await openTwbx(inputData.twbxPath);
      const err = validateLockAgainstWorkbook(opened.twbXml, inputData.lock);
      if (err) return { valid: false, errors: [err], warnings: [] };
      return { valid: true, errors: [], warnings: [] };
    }, "DATASOURCE_LOCK_VIOLATION"),
});

export const applyDatasourceFilter = createTool({
  id: "applyDatasourceFilter",
  description:
    "Prepare a datasource-scoped (context) filter to be applied to generated " +
    "worksheets. Validates the field exists; does not alter the datasource itself.",
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
    filter: WorksheetFilterSpecSchema,
  }),
  outputSchema: toolResult(
    z.object({ filter: WorksheetFilterSpecSchema, fieldExists: z.boolean() }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const fieldName = inputData.filter.field.toLowerCase();
      const exists = r.fields.some((f) => f.name.toLowerCase() === fieldName);
      if (!exists) {
        throw new Error(
          `Field '${inputData.filter.field}' does not exist in the locked datasource.`,
        );
      }
      return { filter: inputData.filter, fieldExists: true };
    }, "FIELD_NOT_FOUND"),
});

export const validateExtract = createTool({
  id: "validateExtract",
  description:
    "Confirm the locked datasource's extract (.hyper) is present in the TWBX.",
  inputSchema: PathInput.extend({ datasourceId: z.string().optional() }),
  outputSchema: toolResult(
    z.object({ hasExtract: z.boolean(), hyperFiles: z.array(z.string()) }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const opened = await openTwbx(inputData.twbxPath);
      const hyperFiles = opened.entries
        .map((e) => e.path)
        .filter((p) => p.toLowerCase().endsWith(".hyper"));
      return { hasExtract: hyperFiles.length > 0, hyperFiles };
    }, "TWBX_INVALID"),
});

export const datasourceTools = {
  validateDatasource,
  lockDatasource,
  validateDatasourceLock,
  applyDatasourceFilter,
  validateExtract,
};
