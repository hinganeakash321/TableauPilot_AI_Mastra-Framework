/**
 * Worksheet specification schemas - the structured output the agent produces and
 * the deterministic compiler consumes (spec sections 39-53).
 *
 * The LLM emits validated instances of these schemas. It NEVER emits XML.
 */

import { z } from "zod";
import {
  AggregationSchema,
  DataTypeSchema,
  DateDerivationSchema,
  FieldRoleSchema,
} from "./common.js";
import { DatasourceLockSchema } from "./datasource.js";

/** Chart types with reliable deterministic templates (spec section 40). */
export const ChartTypeSchema = z.enum([
  "bar",
  "horizontal_bar",
  "stacked_bar",
  "side_by_side_bar",
  "line",
  "dual_line",
  "area",
  "scatter",
  "pie",
  "donut",
  "text_table",
  "highlight_table",
  "heatmap",
  "treemap",
  "map",
  "symbol_map",
  "filled_map",
  "bullet",
  "histogram",
  "box_plot",
  "gantt",
  "funnel",
  "kpi",
  "dual_axis",
  "bubble",
  "bar_line_combo",
]);
export type ChartType = z.infer<typeof ChartTypeSchema>;

/** Tableau shelves the compiler supports (spec section 44). */
export const ShelfSchema = z.enum([
  "rows",
  "columns",
  "color",
  "size",
  "label",
  "detail",
  "tooltip",
  "path",
  "shape",
  "angle",
]);
export type Shelf = z.infer<typeof ShelfSchema>;

/**
 * A field reference on a shelf. `name` must be an actual field in the locked
 * datasource (validated later); `calculation` is only set for inline calc refs
 * that were created via CalculatedFieldSpec.
 */
export const FieldSpecSchema = z.object({
  name: z.string(),
  caption: z.string().optional(),
  dataType: DataTypeSchema.optional(),
  role: FieldRoleSchema.optional(),
  aggregation: AggregationSchema.optional(),
  dateDerivation: DateDerivationSchema.optional(),
  /** Number/date format string, e.g. currency. */
  format: z.string().optional(),
  /** Underlying source field for calculated/derived references. */
  sourceField: z.string().optional(),
  /** Inline calculation formula (validated, never injected raw into XML). */
  calculation: z.string().optional(),
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

/** A field placed on a specific shelf. */
export const ShelfSpecSchema = z.object({
  shelf: ShelfSchema,
  field: FieldSpecSchema,
});
export type ShelfSpec = z.infer<typeof ShelfSpecSchema>;

/** Mark configuration for the worksheet. */
export const MarkSpecSchema = z.object({
  /** Tableau mark class, defaults chosen by chart type when omitted. */
  markType: z
    .enum([
      "automatic",
      "bar",
      "line",
      "area",
      "square",
      "circle",
      "shape",
      "text",
      "pie",
      "gantt",
      "polygon",
      "map",
    ])
    .optional(),
  encodings: z.array(ShelfSpecSchema).default([]),
});
export type MarkSpec = z.infer<typeof MarkSpecSchema>;

/** Filter operators (spec section 47). */
export const FilterOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "greater_than",
  "less_than",
  "between",
  "is_null",
  "is_not_null",
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

/** Top-N filter representation (spec section 48). */
export const TopNSchema = z.object({
  field: z.string(),
  n: z.number().int().positive(),
  byMeasure: z.string(),
  measureAggregation: AggregationSchema.default("sum"),
  direction: z.enum(["top", "bottom"]).default("top"),
});
export type TopN = z.infer<typeof TopNSchema>;

/** A worksheet filter: either a value/comparison filter or a Top-N filter. */
export const WorksheetFilterSpecSchema = z.object({
  field: z.string(),
  operator: FilterOperatorSchema.optional(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  topN: TopNSchema.optional(),
});
export type WorksheetFilterSpec = z.infer<typeof WorksheetFilterSpecSchema>;

/** A calculated field the worksheet needs (spec section 46). */
export const CalculatedFieldSpecSchema = z.object({
  name: z.string(),
  formula: z.string(),
  dataType: DataTypeSchema.optional(),
  role: FieldRoleSchema.optional(),
});
export type CalculatedFieldSpec = z.infer<typeof CalculatedFieldSpecSchema>;

/** A parameter the worksheet needs (spec section 49). */
export const ParameterSpecSchema = z.object({
  name: z.string(),
  dataType: DataTypeSchema,
  currentValue: z.string().optional(),
  allowedValues: z.array(z.string()).optional(),
});
export type ParameterSpec = z.infer<typeof ParameterSpecSchema>;

/** Formatting options (spec section 50). */
export const FormattingSpecSchema = z.object({
  numberFormat: z
    .enum(["currency", "percentage", "number", "scientific"])
    .optional(),
  decimalPlaces: z.number().int().min(0).max(10).optional(),
  dateFormat: z.string().optional(),
  title: z.string().optional(),
  showLabels: z.boolean().optional(),
  alignment: z.enum(["left", "center", "right"]).optional(),
  fontSize: z.number().int().min(6).max(72).optional(),
});
export type FormattingSpec = z.infer<typeof FormattingSpecSchema>;

/** Tooltip configuration. */
export const TooltipSpecSchema = z.object({
  text: z.string().optional(),
  fields: z.array(z.string()).default([]),
});
export type TooltipSpec = z.infer<typeof TooltipSpecSchema>;

/** Full worksheet specification (spec section 42). */
export const WorksheetSpecSchema = z.object({
  name: z.string().min(1),
  datasourceName: z.string(),
  chartType: ChartTypeSchema,
  rows: z.array(FieldSpecSchema).default([]),
  columns: z.array(FieldSpecSchema).default([]),
  marks: z.array(MarkSpecSchema).default([]),
  filters: z.array(WorksheetFilterSpecSchema).default([]),
  calculations: z.array(CalculatedFieldSpecSchema).default([]),
  parameters: z.array(ParameterSpecSchema).default([]),
  formatting: FormattingSpecSchema.optional(),
  tooltip: TooltipSpecSchema.optional(),
});
export type WorksheetSpec = z.infer<typeof WorksheetSpecSchema>;

/**
 * The plan the agent produces before any workbook modification. This is the
 * primary structured output validated by Zod (spec section 74).
 */
export const WorksheetPlanSchema = z.object({
  worksheets: z.array(WorksheetSpecSchema).min(1),
  lockedDatasource: z.object({
    datasourceName: z.string(),
    datasourceId: z.string(),
  }),
  notes: z.string().optional(),
});
export type WorksheetPlan = z.infer<typeof WorksheetPlanSchema>;

/** How to handle a worksheet that collides with an existing name. */
export const CollisionStrategySchema = z.enum([
  "modify_existing",
  "create_new_version",
  "cancel",
]);
export type CollisionStrategy = z.infer<typeof CollisionStrategySchema>;

/** The concrete change plan applied to a workbook (spec section 53). */
export const WorkbookChangePlanSchema = z.object({
  sourceWorkbook: z.string(),
  lockedDatasource: DatasourceLockSchema,
  worksheetsToAdd: z.array(WorksheetSpecSchema).default([]),
  worksheetsToModify: z.array(WorksheetSpecSchema).default([]),
  worksheetsToDelete: z.array(z.string()).default([]),
  calculations: z.array(CalculatedFieldSpecSchema).default([]),
  parameters: z.array(ParameterSpecSchema).default([]),
  filters: z.array(WorksheetFilterSpecSchema).default([]),
});
export type WorkbookChangePlan = z.infer<typeof WorkbookChangePlanSchema>;

/** Result of building/packaging a TWBX (spec section 62, 75, 81). */
export const WorkbookBuildResultSchema = z.object({
  success: z.boolean(),
  outputPath: z.string().optional(),
  worksheetsAdded: z.array(z.string()).default([]),
  worksheetsModified: z.array(z.string()).default([]),
  datasourcePreserved: z.boolean(),
  validationPassed: z.boolean(),
  diff: z
    .object({
      before: z.object({ worksheets: z.number().int().nonnegative() }),
      after: z.object({ worksheets: z.number().int().nonnegative() }),
      added: z.array(z.string()).default([]),
      modified: z.array(z.string()).default([]),
      deleted: z.array(z.string()).default([]),
    })
    .optional(),
  steps: z.array(z.string()).default([]),
});
export type WorkbookBuildResult = z.infer<typeof WorkbookBuildResultSchema>;
