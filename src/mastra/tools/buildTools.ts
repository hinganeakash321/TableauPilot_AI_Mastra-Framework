/**
 * Build tools (spec section 19 - BUILD).
 *
 * Compile specs into a working TWBX, validate the TWB and TWBX, and package the
 * final artifact. Packaging is high-impact and requires approval (spec 18).
 * The datasource and `.hyper` are preserved throughout (spec 36, 60).
 */

import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { compileWorksheet } from "../../tableau/compiler/worksheetCompiler.js";
import {
  compileWorkbookToWorking,
  validateTwbxFile,
  packageTwbx as packageTwbxFn,
} from "../../tableau/build.js";
import { validateTwbxStructure } from "../../tableau/validators/index.js";
import { openTwbx } from "../../tableau/twbx.js";
import {
  WorksheetSpecSchema,
  DatasourceLockSchema,
  ValidationResultSchema,
} from "../schemas/index.js";
import { runTool, toolResult } from "./_shared.js";

const CollisionSchema = z
  .enum(["modify_existing", "create_new_version", "error"])
  .default("create_new_version");

export const compileWorksheetTool = createTool({
  id: "compileWorksheet",
  description:
    "Deterministically compile a single worksheet spec to Tableau XML (in memory) " +
    "and report the fields it declares. Proves the compile succeeds.",
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
    spec: WorksheetSpecSchema,
  }),
  outputSchema: toolResult(
    z.object({
      worksheetName: z.string(),
      xmlLength: z.number(),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const compiled = compileWorksheet(inputData.spec, inputData.lock, r.fields);
      return {
        worksheetName: compiled.name,
        xmlLength: compiled.worksheetXml.length,
      };
    }, "VALIDATION_FAILED"),
});

export const compileWorkbook = createTool({
  id: "compileWorkbook",
  description:
    "Apply worksheet specs to the source TWBX and write a WORKING TWBX (original " +
    "is never modified). Enforces the datasource lock. Returns the working path " +
    "and a before/after worksheet diff.",
  inputSchema: z.object({
    sourceTwbxPath: z.string(),
    lock: DatasourceLockSchema,
    specs: z.array(WorksheetSpecSchema).min(1),
    collision: CollisionSchema,
  }),
  outputSchema: toolResult(
    z.object({
      workingPath: z.string(),
      added: z.array(z.string()),
      modified: z.array(z.string()),
      errors: z.array(z.object({ code: z.string(), message: z.string() })),
      beforeWorksheets: z.number(),
      afterWorksheets: z.number(),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.sourceTwbxPath);
      const res = await compileWorkbookToWorking({
        sourceTwbxPath: inputData.sourceTwbxPath,
        specs: inputData.specs,
        lock: inputData.lock,
        fields: r.fields,
        collision: inputData.collision,
      });
      return {
        workingPath: res.workingPath,
        added: res.added,
        modified: res.modified,
        errors: res.errors.map((e) => ({ code: e.code, message: e.message })),
        beforeWorksheets: res.beforeWorksheets,
        afterWorksheets: res.afterWorksheets,
      };
    }, "VALIDATION_FAILED"),
});

export const validateTwb = createTool({
  id: "validateTwb",
  description:
    "Validate the TWB inside a TWBX: well-formed XML, datasource-lock integrity, " +
    "field existence for target worksheets, and worksheet/window references.",
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
    targetWorksheets: z.array(z.string()).optional(),
  }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const { result } = await validateTwbxFile({
        twbxPath: inputData.twbxPath,
        lock: inputData.lock,
        fields: r.fields,
        targetWorksheets: inputData.targetWorksheets,
      });
      return result;
    }, "VALIDATION_FAILED"),
});

export const validateTwbx = createTool({
  id: "validateTwbx",
  description:
    "Validate TWBX archive structure: exactly one .twb, Data/ resources present, " +
    "and well-formed XML.",
  inputSchema: z.object({ twbxPath: z.string() }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(async () => {
      const opened = await openTwbx(inputData.twbxPath);
      return validateTwbxStructure(opened);
    }, "TWBX_INVALID"),
});

export const packageTwbx = createTool({
  id: "packageTwbx",
  description:
    "Package a working TWBX into the output directory as the final downloadable " +
    "artifact (high-impact - requires approval).",
  requireApproval: true,
  inputSchema: z.object({
    workingTwbxPath: z.string(),
    outputName: z.string(),
  }),
  outputSchema: toolResult(z.object({ outputPath: z.string() })),
  execute: async (inputData) =>
    runTool(
      () =>
        packageTwbxFn({
          workingTwbxPath: inputData.workingTwbxPath,
          outputName: inputData.outputName,
        }),
      "IO_ERROR",
    ),
});

export const buildTools = {
  compileWorksheet: compileWorksheetTool,
  compileWorkbook,
  validateTwb,
  validateTwbx,
  packageTwbx,
};
