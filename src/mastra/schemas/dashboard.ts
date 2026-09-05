/**
 * Dashboard specification schemas - the structured output the agent produces and
 * the deterministic dashboard compiler consumes. Modeled on the two sample
 * dashboards in `sample_workbook.twbx` (see `sample_dashboard_analysis.md`).
 *
 * The LLM emits validated instances of these schemas. It NEVER emits XML.
 */

import { z } from "zod";
import { TextFormatSchema, BorderSpecSchema } from "./common.js";

/** Fixed vs automatic dashboard sizing (Tableau `<size sizing-mode>`). */
/**
 * Dashboard sizing mode (matches Tableau's three options):
 * - `automatic`: the dashboard resizes to fill whatever window shows it.
 * - `range`: the dashboard scales between a MIN and MAX size (min/max width+height).
 * - `fixed`: the dashboard is a single exact size (width x height).
 */
export const DashboardSizeModeSchema = z.enum(["automatic", "range", "fixed"]);
export type DashboardSizeMode = z.infer<typeof DashboardSizeModeSchema>;

/**
 * Dashboard filter presentation. `checkdropdown` = multiple-selection dropdown,
 * matching the sample dashboards (the default and recommended value).
 */
export const DashboardFilterModeSchema = z.enum([
  "checkdropdown",
  "typeindropdown",
  "multivaluelist",
  "singlevaluelist",
]);
export type DashboardFilterMode = z.infer<typeof DashboardFilterModeSchema>;

/** Which values the filter control shows: relevant-only or the full database. */
export const DashboardFilterValuesSchema = z.enum(["relevant", "database"]);
export type DashboardFilterValues = z.infer<typeof DashboardFilterValuesSchema>;

/** Configuration for the dashboard's Filters panel. */
export const DashboardFiltersSpecSchema = z.object({
  /** Dimension field names (real datasource fields) to expose as filters. */
  fields: z.array(z.string()).default([]),
  /**
   * Parameter DISPLAY NAMES (captions) to show as controls in the filters panel,
   * e.g. a "Top N" parameter that drives a Top-N filter. Each is rendered as a
   * Tableau parameter control (`type-v2='paramctrl'`) alongside the field
   * filters. The parameter must already exist or be created in the same build
   * (e.g. via a Top-N filter's `topN.nParameter`, or a ParameterSpec).
   */
  parameters: z.array(z.string()).default([]),
  /**
   * When true, each filter is applied to ALL worksheets using the locked
   * datasource (Tableau "Apply to Worksheets -> All Using This Data Source").
   * Implemented by injecting a shared `filter-group` context filter into every
   * worksheet. Defaults to true, matching the sample dashboards.
   */
  applyToAllWorksheets: z.boolean().default(true),
  /** Multi-select dropdown by default (sample uses `checkdropdown`). */
  mode: DashboardFilterModeSchema.default("checkdropdown"),
  /** Show the Apply button (defer query until applied). Sample: true. */
  showApply: z.boolean().default(true),
  /** Relevant values only by default (date filters fall back to `database`). */
  values: DashboardFilterValuesSchema.default("relevant"),
  /** Heading shown above the filter controls. */
  panelTitle: z.string().default("Filters"),
  /** Formatting of the filter panel heading (font size/color/bold/alignment). */
  panelTitleFormat: TextFormatSchema.optional(),
  /**
   * The worksheet the filter controls are anchored to (Tableau stores a source
   * sheet name on each filter zone). Defaults to the first sheet on the board.
   */
  sourceWorksheet: z.string().optional(),
});
export type DashboardFiltersSpec = z.infer<typeof DashboardFiltersSpecSchema>;

/** A single worksheet placed in a dashboard grid cell. */
export const DashboardSheetSchema = z.object({
  /** Must match an existing worksheet name in the workbook. */
  worksheet: z.string().min(1),
  /** Whether to show the worksheet's title on the dashboard. */
  showTitle: z.boolean().optional(),
  /** Relative width weight within its row (defaults to equal). */
  widthWeight: z.number().positive().optional(),
  /**
   * Explicit container WIDTH. On a fixed/range dashboard treat this as pixels
   * (the cells' widths should sum to the dashboard width); otherwise it acts as a
   * relative weight. Takes precedence over `widthWeight` when both are set.
   */
  width: z.number().positive().optional(),
});
export type DashboardSheet = z.infer<typeof DashboardSheetSchema>;

/** A horizontal row of worksheets in the dashboard grid. */
export const DashboardRowSchema = z.object({
  sheets: z.array(DashboardSheetSchema).min(1),
  /** Relative height weight within the board (defaults to equal). */
  heightWeight: z.number().positive().optional(),
  /**
   * Explicit row HEIGHT. On a fixed/range dashboard treat this as pixels (rows'
   * heights should sum to the content height); otherwise it acts as a relative
   * weight. Takes precedence over `heightWeight` when both are set.
   */
  height: z.number().positive().optional(),
});
export type DashboardRow = z.infer<typeof DashboardRowSchema>;

/**
 * A dashboard action. Currently supports FILTER actions ("use as filter"): when a
 * mark on a source sheet is selected, it filters the target sheets. Modeled on
 * the sample dashboard's filter action (`command='tsc:tsl-filter'`).
 */
export const DashboardActionSpecSchema = z.object({
  type: z.literal("filter").default("filter"),
  /** Action caption shown in Tableau (defaults to "Filter on <dashboard>"). */
  caption: z.string().optional(),
  /**
   * When the action runs. `select` = on click (default, `auto-clear` on),
   * `hover` = on hover, `menu` = via the tooltip menu.
   */
  runOn: z.enum(["select", "hover", "menu"]).default("select"),
  /**
   * Worksheets on THIS dashboard that should NOT trigger the filter (e.g. KPI
   * cards). When omitted the compiler excludes KPI sheets automatically.
   */
  excludeSheets: z.array(z.string()).default([]),
});
export type DashboardActionSpec = z.infer<typeof DashboardActionSpecSchema>;

/** Full dashboard specification. */
export const DashboardSpecSchema = z.object({
  name: z.string().min(1),
  /** Title text shown in the top band (defaults to the dashboard name). */
  title: z.string().optional(),
  sizeMode: DashboardSizeModeSchema.default("automatic"),
  /** Fixed-size width/height in px (only used when sizeMode = 'fixed'). */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /**
   * Range-size bounds in px (only used when sizeMode = 'range'). The dashboard
   * scales between (minWidth x minHeight) and (maxWidth x maxHeight). Sensible
   * defaults are applied when a bound is omitted.
   */
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  /** Dashboard background color (sample: #e6e6e6). */
  backgroundColor: z.string().default("#e6e6e6"),
  /** Per-chart container background color (sample: #ffffff). */
  containerBackground: z.string().default("#ffffff"),
  /**
   * Outer padding (the dashboard's outermost margin, in px). Sample ~8. This is
   * the gap between the dashboard edge and its contents.
   */
  outerPadding: z.number().int().min(0).max(200).default(8),
  /**
   * Inner padding (each zone/container's margin, in px). Sample ~4. This is the
   * gap around each chart container and the title/filter zones.
   */
  innerPadding: z.number().int().min(0).max(200).default(4),
  /** Optional border drawn around chart containers (default: none). */
  border: BorderSpecSchema.optional(),
  /** Formatting of the dashboard title band (font size/color/bold/alignment). */
  titleFormat: TextFormatSchema.optional(),
  /** Grid of worksheet rows (top to bottom). */
  rows: z.array(DashboardRowSchema).min(1),
  /** Optional Filters panel on the right. */
  filters: DashboardFiltersSpecSchema.optional(),
  /** Optional dashboard actions (e.g. use-as-filter). */
  actions: z.array(DashboardActionSpecSchema).optional(),
});
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;
