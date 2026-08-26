/**
 * TWBX build workflow (spec sections 15, 60-62).
 *
 * modified TWB -> XML validation -> datasource validation -> worksheet
 * validation -> package TWBX -> final validation. Deterministic (no LLM, no
 * HITL) - approval happens upstream in the generation workflow.
 */

import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { buildWorkbook } from "../../tableau/build.js";
import {
  DatasourceLockSchema,
  WorksheetSpecSchema,
  WorkbookBuildResultSchema,
} from "../schemas/index.js";

const inputSchema = z.object({
  sourceTwbxPath: z.string(),
  lock: DatasourceLockSchema,
  specs: z.array(WorksheetSpecSchema).min(1),
  collision: z
    .enum(["modify_existing", "create_new_version", "error"])
    .default("create_new_version"),
  outputName: z.string().optional(),
});

const build = createStep({
  id: "compileValidatePackage",
  description: "Compile specs, validate the TWB/TWBX, and package the output.",
  inputSchema,
  outputSchema: WorkbookBuildResultSchema,
  execute: async ({ inputData }) => {
    const inspection = await inspectWorkbookFile(inputData.sourceTwbxPath);
    return buildWorkbook({
      sourceTwbxPath: inputData.sourceTwbxPath,
      specs: inputData.specs,
      lock: inputData.lock,
      fields: inspection.fields,
      collision: inputData.collision,
      outputName: inputData.outputName,
    });
  },
});

export const twbxBuildWorkflow = createWorkflow({
  id: "twbxBuildWorkflow",
  description: "Validate and package modified worksheets into a downloadable TWBX.",
  inputSchema,
  outputSchema: WorkbookBuildResultSchema,
})
  .then(build)
  .commit();
