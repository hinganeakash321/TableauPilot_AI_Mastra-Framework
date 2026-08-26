/**
 * Worksheet tools (spec section 19 - WORKSHEET).
 *
 * These validate and dry-compile worksheet specs. Fields are checked against the
 * locked datasource (spec 45); the LLM never emits XML - the deterministic
 * compiler does (spec 39). Actual file writes happen in the build tools.
 */

import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { compileWorksheet, FieldIndex } from "../../tableau/compiler/worksheetCompiler.js";
import { getChartRecipe, supportedChartTypes } from "../../../templates/registry/index.js";
import {
  WorksheetSpecSchema,
  DatasourceLockSchema,
  ValidationResultSchema,
  CalculatedFieldSpecSchema,
  ParameterSpecSchema,
  WorksheetFilterSpecSchema,
  FieldInfoSchema,
  type WorksheetSpec,
  type FieldInfo,
  type StructuredError,
} from "../schemas/index.js";
import { runTool, toolResult } from "./_shared.js";

/** Collects every field name referenced by a worksheet spec. */
function referencedFields(spec: WorksheetSpec): string[] {
  const names = new Set<string>();
  for (const f of [...spec.rows, ...spec.columns]) names.add(f.name);
  for (const m of spec.marks) for (const e of m.encodings) names.add(e.field.name);
  for (const fl of spec.filters) {
    names.add(fl.field);
    if (fl.topN) {
      names.add(fl.topN.field);
      names.add(fl.topN.byMeasure);
    }
  }
  return [...names];
}

/** Validates referenced fields exist; returns structured errors with suggestions. */
function validateSpecFields(
  spec: WorksheetSpec,
  fields: FieldInfo[],
): StructuredError[] {
  const index = new FieldIndex(fields);
  const errors: StructuredError[] = [];
  // Calculated fields declared inline are allowed as new names.
  const declaredCalcs = new Set(spec.calculations.map((c) => c.name.toLowerCase()));
  for (const name of referencedFields(spec)) {
    if (declaredCalcs.has(name.toLowerCase())) continue;
    if (!index.has(name)) {
      errors.push({
        code: "FIELD_NOT_FOUND",
        message: `Field '${name}' does not exist in the locked datasource.`,
        suggestions: suggest(name, fields),
      });
    }
  }
  return errors;
}

function suggest(name: string, fields: FieldInfo[]): string[] {
  const t = name.toLowerCase();
  return fields
    .map((f) => {
      const n = f.name.toLowerCase();
      const score = n === t ? 1 : n.includes(t) || t.includes(n) ? 0.8 : 0;
      return { name: f.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.name);
}

export const validateField = createTool({
  id: "validateField",
  description:
    "Check whether a field exists in the workbook. Returns close matches when " +
    "it does not (spec 45).",
  inputSchema: z.object({ twbxPath: z.string(), fieldName: z.string() }),
  outputSchema: toolResult(
    z.object({
      exists: z.boolean(),
      field: FieldInfoSchema.optional(),
      suggestions: z.array(z.string()),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const field = r.fields.find(
        (f) => f.name.toLowerCase() === inputData.fieldName.toLowerCase(),
      );
      return {
        exists: Boolean(field),
        field,
        suggestions: field ? [] : suggest(inputData.fieldName, r.fields),
      };
    }, "FIELD_NOT_FOUND"),
});

/** Dry-compiles a single worksheet spec and validates it. */
async function dryValidateWorksheet(
  twbxPath: string,
  lock: z.infer<typeof DatasourceLockSchema>,
  spec: WorksheetSpec,
) {
  const r = await inspectWorkbookFile(twbxPath);
  const chartTypes = supportedChartTypes();
  const errors: StructuredError[] = [];
  if (!chartTypes.includes(spec.chartType)) {
    errors.push({
      code: "UNSUPPORTED_CHART_TYPE",
      message: `Chart type '${spec.chartType}' is not supported.`,
      suggestions: chartTypes,
    });
  }
  errors.push(...validateSpecFields(spec, r.fields));
  if (errors.length === 0) {
    // Ensure the compiler can build it without throwing.
    compileWorksheet(spec, lock, r.fields);
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings: [] as string[],
  };
}

export const createWorksheet = createTool({
  id: "createWorksheet",
  description:
    "Validate and dry-compile a worksheet spec against the locked datasource. " +
    "Returns a ValidationResult; the worksheet is written during the build step.",
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
    spec: WorksheetSpecSchema,
  }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(
      () => dryValidateWorksheet(inputData.twbxPath, inputData.lock, inputData.spec),
      "VALIDATION_FAILED",
    ),
});

export const modifyWorksheet = createTool({
  id: "modifyWorksheet",
  description:
    "Validate a change to an EXISTING worksheet (high-impact). Requires approval " +
    "because it overwrites an existing sheet during the build step.",
  requireApproval: true,
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
    spec: WorksheetSpecSchema,
  }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(
      () => dryValidateWorksheet(inputData.twbxPath, inputData.lock, inputData.spec),
      "VALIDATION_FAILED",
    ),
});

export const createCalculatedField = createTool({
  id: "createCalculatedField",
  description:
    "Validate a calculated field: referenced fields must exist; formula is kept " +
    "verbatim (never injected by the LLM into XML).",
  inputSchema: z.object({
    twbxPath: z.string(),
    calculation: CalculatedFieldSpecSchema,
  }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const known = new Set(r.fields.map((f) => f.name.toLowerCase()));
      const refs = [...inputData.calculation.formula.matchAll(/\[([^\]]+)\]/g)].map(
        (m) => m[1]!,
      );
      const errors: StructuredError[] = [];
      for (const ref of refs) {
        if (!known.has(ref.toLowerCase())) {
          errors.push({
            code: "FIELD_NOT_FOUND",
            message: `Calculation references unknown field '${ref}'.`,
            suggestions: suggest(ref, r.fields),
          });
        }
      }
      return { valid: errors.length === 0, errors, warnings: [] };
    }, "VALIDATION_FAILED"),
});

export const createParameter = createTool({
  id: "createParameter",
  description: "Validate a parameter specification.",
  inputSchema: z.object({ parameter: ParameterSpecSchema }),
  outputSchema: toolResult(ValidationResultSchema),
  execute: async (inputData) =>
    runTool(async () => {
      const errors: StructuredError[] = [];
      if (!inputData.parameter.name.trim()) {
        errors.push({ code: "VALIDATION_FAILED", message: "Parameter needs a name." });
      }
      return { valid: errors.length === 0, errors, warnings: [] };
    }, "VALIDATION_FAILED"),
});

export const addWorksheetFilter = createTool({
  id: "addWorksheetFilter",
  description:
    "Validate a worksheet filter (value/comparison or Top-N) against the workbook.",
  inputSchema: z.object({
    twbxPath: z.string(),
    filter: WorksheetFilterSpecSchema,
  }),
  outputSchema: toolResult(
    z.object({ filter: WorksheetFilterSpecSchema, valid: z.boolean() }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const known = new Set(r.fields.map((f) => f.name.toLowerCase()));
      const need = [inputData.filter.field];
      if (inputData.filter.topN) {
        need.push(inputData.filter.topN.field, inputData.filter.topN.byMeasure);
      }
      for (const n of need) {
        if (!known.has(n.toLowerCase())) {
          throw new Error(`Filter references unknown field '${n}'.`);
        }
      }
      return { filter: inputData.filter, valid: true };
    }, "FIELD_NOT_FOUND"),
});

export const validateWorksheet = createTool({
  id: "validateWorksheet",
  description:
    "Full validation of a worksheet spec: chart support, field existence, and a " +
    "compile dry-run. Also reports the shelves the chart type requires.",
  inputSchema: z.object({
    twbxPath: z.string(),
    lock: DatasourceLockSchema,
    spec: WorksheetSpecSchema,
  }),
  outputSchema: toolResult(
    ValidationResultSchema.extend({ requiredShelves: z.array(z.string()) }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const base = await dryValidateWorksheet(
        inputData.twbxPath,
        inputData.lock,
        inputData.spec,
      );
      const recipe = getChartRecipe(inputData.spec.chartType);
      return { ...base, requiredShelves: recipe?.requiredShelves ?? [] };
    }, "VALIDATION_FAILED"),
});

export const worksheetTools = {
  validateField,
  createWorksheet,
  modifyWorksheet,
  createCalculatedField,
  createParameter,
  addWorksheetFilter,
  validateWorksheet,
};
