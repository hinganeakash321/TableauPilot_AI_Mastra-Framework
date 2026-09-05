/**
 * Worksheet generation workflow with human-in-the-loop (spec sections 15, 17).
 *
 * validate plan -> HUMAN APPROVAL (suspend/resume) -> compile -> validate ->
 * package. The workbook is never modified before approval. Uses Mastra's real
 * suspend/resume, not a boolean flag.
 */

import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { buildWorkbook } from "../../tableau/build.js";
import { FieldIndex } from "../../tableau/compiler/worksheetCompiler.js";
import { supportedChartTypes } from "../../../templates/registry/index.js";
import {
  DatasourceLockSchema,
  WorksheetPlanSchema,
  WorkbookBuildResultSchema,
  StructuredErrorSchema,
} from "../schemas/index.js";

const inputSchema = z.object({
  sourceTwbxPath: z.string(),
  lock: DatasourceLockSchema,
  plan: WorksheetPlanSchema,
  collision: z
    .enum(["modify_existing", "create_new_version", "error"])
    .default("create_new_version"),
  outputName: z.string().optional(),
});

const outputSchema = WorkbookBuildResultSchema.extend({
  cancelled: z.boolean().default(false),
  validationErrors: z.array(StructuredErrorSchema).default([]),
});

const suspendSchema = z.object({
  reason: z.literal("approval_required"),
  planPreview: z.array(
    z.object({
      name: z.string(),
      chartType: z.string(),
      rows: z.array(z.string()),
      columns: z.array(z.string()),
      filters: z.number(),
    }),
  ),
  lockedDatasource: z.string(),
  validationErrors: z.array(StructuredErrorSchema),
});

const resumeSchema = z.object({
  approved: z.boolean(),
});

const generate = createStep({
  id: "generateWorksheets",
  description:
    "Validate the plan, suspend for human approval, then compile/validate/package.",
  inputSchema,
  outputSchema,
  suspendSchema,
  resumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const inspection = await inspectWorkbookFile(inputData.sourceTwbxPath);
    const index = new FieldIndex(inspection.fields);
    const supported = new Set(supportedChartTypes());

    // Validate every spec's chart type and field references up front.
    const validationErrors = [] as z.infer<typeof StructuredErrorSchema>[];
    for (const spec of inputData.plan.worksheets) {
      if (!supported.has(spec.chartType)) {
        validationErrors.push({
          code: "UNSUPPORTED_CHART_TYPE",
          message: `Worksheet '${spec.name}' uses unsupported chart '${spec.chartType}'.`,
        });
      }
      const declaredCalcs = new Set(
        spec.calculations.map((c) => c.name.toLowerCase()),
      );
      const refs = new Set<string>();
      [...spec.rows, ...spec.columns].forEach((f) => refs.add(f.name));
      spec.marks.forEach((m) => m.encodings.forEach((e) => refs.add(e.field.name)));
      spec.filters.forEach((fl) => {
        refs.add(fl.field);
        if (fl.topN) {
          refs.add(fl.topN.field);
          refs.add(fl.topN.byMeasure);
        }
      });
      for (const name of refs) {
        if (declaredCalcs.has(name.toLowerCase())) continue;
        if (!index.has(name)) {
          validationErrors.push({
            code: "FIELD_NOT_FOUND",
            message: `Worksheet '${spec.name}' references unknown field '${name}'.`,
          });
        }
      }
    }

    // First invocation: suspend for human approval (spec 17).
    if (!resumeData) {
      return suspend({
        reason: "approval_required",
        lockedDatasource: inputData.lock.datasourceName,
        validationErrors,
        planPreview: inputData.plan.worksheets.map((w) => ({
          name: w.name,
          chartType: w.chartType,
          rows: w.rows.map((f) => f.name),
          columns: w.columns.map((f) => f.name),
          filters: w.filters.length,
        })),
      });
    }

    // Resumed: honor the human decision.
    if (!resumeData.approved) {
      return {
        success: false,
        cancelled: true,
        worksheetsAdded: [],
        worksheetsModified: [],
        dashboardsAdded: [],
        dashboardsModified: [],
        datasourcePreserved: true,
        validationPassed: false,
        steps: ["Cancelled by user before any modification"],
        validationErrors,
      };
    }

    if (validationErrors.length > 0) {
      return {
        success: false,
        cancelled: false,
        worksheetsAdded: [],
        worksheetsModified: [],
        dashboardsAdded: [],
        dashboardsModified: [],
        datasourcePreserved: true,
        validationPassed: false,
        steps: ["Plan validation failed; no modification performed"],
        validationErrors,
      };
    }

    const result = await buildWorkbook({
      sourceTwbxPath: inputData.sourceTwbxPath,
      specs: inputData.plan.worksheets,
      lock: inputData.lock,
      fields: inspection.fields,
      collision: inputData.collision,
      outputName: inputData.outputName,
    });

    return { ...result, cancelled: false, validationErrors: [] };
  },
});

export const worksheetGenerationWorkflow = createWorkflow({
  id: "worksheetGenerationWorkflow",
  description:
    "Generate worksheets with human approval, then build a validated TWBX.",
  inputSchema,
  outputSchema,
})
  .then(generate)
  .commit();
