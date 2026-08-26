/**
 * Workbook inspection workflow (spec section 15).
 *
 * upload -> preserve original -> inspect -> datasource discovery -> lock.
 * Deterministic (no LLM). Auto-locks a single datasource; reports when a
 * selection is required.
 */

import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { preserveOriginal } from "../../tableau/twbx.js";
import { resolveLock } from "../../tableau/lock.js";
import {
  WorkbookInspectionResultSchema,
  DatasourceLockSchema,
  DatasourceInfoSchema,
} from "../schemas/index.js";

const inputSchema = z.object({
  twbxPath: z.string(),
  selectedDatasourceId: z.string().optional(),
});

const outputSchema = z.object({
  originalPath: z.string(),
  inspection: WorkbookInspectionResultSchema,
  lock: DatasourceLockSchema.optional(),
  requiresSelection: z.boolean(),
  datasources: z.array(DatasourceInfoSchema),
});

const inspectAndLock = createStep({
  id: "inspectAndLock",
  description: "Preserve the original, inspect metadata, and lock the datasource.",
  inputSchema,
  outputSchema,
  execute: async ({ inputData }) => {
    const originalPath = await preserveOriginal(inputData.twbxPath);
    const inspection = await inspectWorkbookFile(originalPath);
    const outcome = resolveLock(
      inspection,
      originalPath,
      inputData.selectedDatasourceId,
    );
    if (outcome.ok) {
      return {
        originalPath,
        inspection,
        lock: outcome.lock,
        requiresSelection: false,
        datasources: inspection.datasources,
      };
    }
    return {
      originalPath,
      inspection,
      lock: undefined,
      requiresSelection: outcome.error.code === "MULTIPLE_DATASOURCES",
      datasources: inspection.datasources,
    };
  },
});

export const workbookInspectionWorkflow = createWorkflow({
  id: "workbookInspectionWorkflow",
  description:
    "Inspect a TWBX and lock its datasource as the single source of truth.",
  inputSchema,
  outputSchema,
})
  .then(inspectAndLock)
  .commit();
