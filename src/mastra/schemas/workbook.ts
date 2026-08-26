/**
 * Workbook inspection schemas (spec sections 32, 42, 43).
 */

import { z } from "zod";
import {
  AggregationSchema,
  DataTypeSchema,
  FieldRoleSchema,
} from "./common.js";
import { DatasourceInfoSchema } from "./datasource.js";

/** A field (column) discovered in a datasource. */
export const FieldInfoSchema = z.object({
  /** Raw field name as referenced in XML, e.g. `[Sales]` without brackets. */
  name: z.string(),
  caption: z.string().optional(),
  dataType: DataTypeSchema,
  role: FieldRoleSchema,
  /** Default aggregation Tableau applies for this field, if any. */
  defaultAggregation: AggregationSchema.optional(),
  /** Whether this is a calculated field. */
  isCalculated: z.boolean().default(false),
  /** Owning datasource id. */
  datasourceId: z.string(),
  /** Default number/date format string from the workbook, if present. */
  defaultFormat: z.string().optional(),
});
export type FieldInfo = z.infer<typeof FieldInfoSchema>;

/** A calculated field discovered in the workbook. */
export const CalculatedFieldInfoSchema = z.object({
  name: z.string(),
  caption: z.string().optional(),
  formula: z.string(),
  dataType: DataTypeSchema.optional(),
  role: FieldRoleSchema.optional(),
  datasourceId: z.string(),
});
export type CalculatedFieldInfo = z.infer<typeof CalculatedFieldInfoSchema>;

/** A parameter discovered in the workbook. */
export const ParameterInfoSchema = z.object({
  name: z.string(),
  caption: z.string().optional(),
  dataType: DataTypeSchema,
  currentValue: z.string().optional(),
  allowedValues: z.array(z.string()).optional(),
});
export type ParameterInfo = z.infer<typeof ParameterInfoSchema>;

/** An existing worksheet discovered in the workbook. */
export const WorksheetInfoSchema = z.object({
  name: z.string(),
  datasourceId: z.string().optional(),
  /** Field references used on rows/cols, for context only. */
  usedFields: z.array(z.string()).default([]),
});
export type WorksheetInfo = z.infer<typeof WorksheetInfoSchema>;

/**
 * Full result of inspecting a TWBX (spec sections 32, WorkbookInspectionResult).
 * This is metadata only - the full TWB XML is never included here (context
 * management, spec section 57).
 */
export const WorkbookInspectionResultSchema = z.object({
  workbookName: z.string(),
  tableauVersion: z.string().optional(),
  sourceBuild: z.string().optional(),
  datasources: z.array(DatasourceInfoSchema),
  fields: z.array(FieldInfoSchema),
  calculatedFields: z.array(CalculatedFieldInfoSchema).default([]),
  parameters: z.array(ParameterInfoSchema).default([]),
  worksheets: z.array(WorksheetInfoSchema).default([]),
  /** Convenience counts for UI/summary display. */
  counts: z.object({
    datasources: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    dimensions: z.number().int().nonnegative(),
    measures: z.number().int().nonnegative(),
    calculatedFields: z.number().int().nonnegative(),
    parameters: z.number().int().nonnegative(),
    worksheets: z.number().int().nonnegative(),
  }),
});
export type WorkbookInspectionResult = z.infer<
  typeof WorkbookInspectionResultSchema
>;
