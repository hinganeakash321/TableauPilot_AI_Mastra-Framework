/**
 * Chart-type registry.
 *
 * Maps each supported {@link ChartType} to the deterministic recipe derived from
 * the REAL sample workbook (see `templates/sample-1/` and
 * `sample_workbook_analysis.md`). The compiler uses `markClass` and placement
 * hints; validation uses `requiredShelves` to tell the user what a chart needs.
 *
 * This is data, not XML generation - the LLM never touches XML (spec section 39).
 */

import type { ChartType, Shelf } from "../../src/mastra/schemas/worksheet.js";

/** Where the primary dimension/measure go for a chart family. */
export type Placement = "measureOnRows" | "measureOnCols" | "none";

export interface ChartRecipe {
  /** Tableau `<mark class='...'>` value. */
  markClass: string;
  /** Human description shown in tool docs / errors. */
  description: string;
  /** Shelves that must have at least one field for this chart to be meaningful. */
  requiredShelves: Shelf[];
  /** Optional encoding shelves commonly used by this chart. */
  optionalShelves: Shelf[];
  /** Default placement of the primary measure. */
  placement: Placement;
  /** Whether the chart stacks a dimension onto color by default. */
  usesColorDimension: boolean;
  /** Whether both axes are measures (scatter-like). */
  dualMeasureAxes: boolean;
  /** Whether this is a dual-axis chart (two measures, one per axis). */
  dualAxis: boolean;
  /** Whether rows/cols are left empty (KPI). */
  emptyRowsCols: boolean;
  /**
   * Whether the sample workbook shows value (mark) labels for this chart family.
   * When true the compiler adds a measure text label + `mark-labels-show/cull`
   * and applies the measure's number format, matching the sample charts.
   */
  showsValueLabels?: boolean;
  /** Reference template file in templates/sample-1. */
  referenceTemplate: string;
}

export const CHART_REGISTRY: Record<ChartType, ChartRecipe> = {
  bar: {
    markClass: "Bar",
    description: "Vertical bar: dimension on columns, measure on rows.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "label", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    showsValueLabels: true,
    referenceTemplate: "ws_sample_vertical_bar_chart.xml",
  },
  horizontal_bar: {
    markClass: "Bar",
    description: "Horizontal bar: dimension on rows, measure on columns.",
    requiredShelves: ["rows", "columns"],
    optionalShelves: ["color", "label", "tooltip"],
    placement: "measureOnCols",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    showsValueLabels: true,
    referenceTemplate: "ws_sample_horizontal_bar_chart.xml",
  },
  stacked_bar: {
    markClass: "Bar",
    description: "Stacked bar: dimension on axis, second dimension on color.",
    requiredShelves: ["columns", "rows", "color"],
    optionalShelves: ["label", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: true,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_stacked_bar_chart.xml",
  },
  side_by_side_bar: {
    markClass: "Bar",
    description: "Side-by-side bar: dimension on color and columns.",
    requiredShelves: ["columns", "rows", "color"],
    optionalShelves: ["label", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: true,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_side_by_side_bar_chart.xml",
  },
  line: {
    markClass: "Line",
    description: "Line: continuous date on columns, measure on rows.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_line_chart.xml",
  },
  dual_line: {
    markClass: "Line",
    description: "Dual line: two measures over a date via Measure Names.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: true,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_dual_line_chart.xml",
  },
  area: {
    markClass: "Area",
    description: "Area: continuous date on columns, measure on rows.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_area_chart.xml",
  },
  scatter: {
    markClass: "Shape",
    description: "Scatter: measure on both axes, dimension on color/detail.",
    requiredShelves: ["rows", "columns"],
    optionalShelves: ["color", "detail", "size", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: true,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_scatter_plot.xml",
  },
  pie: {
    markClass: "Pie",
    description: "Pie: dimension on color, measure on angle (wedge-size).",
    requiredShelves: ["color", "angle"],
    optionalShelves: ["label", "tooltip"],
    placement: "none",
    usesColorDimension: true,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: true,
    referenceTemplate: "ws_sample_pie_chart.xml",
  },
  donut: {
    markClass: "Pie",
    description: "Donut: pie variant (dimension color, measure angle).",
    requiredShelves: ["color", "angle"],
    optionalShelves: ["label", "tooltip"],
    placement: "none",
    usesColorDimension: true,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: true,
    referenceTemplate: "ws_sample_donut_chart.xml",
  },
  text_table: {
    markClass: "Automatic",
    description: "Text table: dimensions on rows/cols, measures on text.",
    requiredShelves: ["rows", "label"],
    optionalShelves: ["columns", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_text_table.xml",
  },
  highlight_table: {
    markClass: "Square",
    description: "Highlight table: dimensions on rows/cols, measure on color.",
    requiredShelves: ["rows", "columns", "color"],
    optionalShelves: ["label", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_highlight_table.xml",
  },
  heatmap: {
    markClass: "Square",
    description: "Heatmap: dimensions on rows/cols, measure on color/size.",
    requiredShelves: ["rows", "columns", "color"],
    optionalShelves: ["size", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_highlight_table.xml",
  },
  treemap: {
    markClass: "Automatic",
    description: "Treemap: measure on size+color, dimension on text.",
    requiredShelves: ["size", "label"],
    optionalShelves: ["color", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: true,
    referenceTemplate: "ws_sample_tree_map.xml",
  },
  map: {
    markClass: "Automatic",
    description: "Map: generated Lat/Long, geographic dimension on detail.",
    requiredShelves: ["detail"],
    optionalShelves: ["color", "size", "label", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_symbol_map.xml",
  },
  symbol_map: {
    markClass: "Automatic",
    description: "Symbol map: generated Lat/Long, measure on size.",
    requiredShelves: ["detail"],
    optionalShelves: ["color", "size", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_symbol_map.xml",
  },
  filled_map: {
    markClass: "Automatic",
    description: "Filled map: generated Lat/Long, measure on color.",
    requiredShelves: ["detail", "color"],
    optionalShelves: ["label", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_filled_map.xml",
  },
  bullet: {
    markClass: "Bar",
    description: "Bullet: dimension on rows, measure on columns (with ref line).",
    requiredShelves: ["rows", "columns"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnCols",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_horizontal_bar_chart.xml",
  },
  histogram: {
    markClass: "Bar",
    description: "Histogram: measure bins on columns, count on rows.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_histogram.xml",
  },
  box_plot: {
    markClass: "Circle",
    description: "Box plot: dimension on columns, measure on rows.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_vertical_bar_chart.xml",
  },
  gantt: {
    markClass: "Gantt",
    description: "Gantt: date on columns, dimension on rows.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "size", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_horizontal_bar_chart.xml",
  },
  funnel: {
    markClass: "Bar",
    description: "Funnel: dimension on rows, measure on columns.",
    requiredShelves: ["rows", "columns"],
    optionalShelves: ["color", "label", "tooltip"],
    placement: "measureOnCols",
    usesColorDimension: true,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_horizontal_bar_chart.xml",
  },
  kpi: {
    markClass: "Automatic",
    description: "KPI: single aggregated measure as big text (no rows/cols).",
    requiredShelves: ["label"],
    optionalShelves: ["tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: true,
    referenceTemplate: "ws_sample_kpi_chart.xml",
  },
  dual_axis: {
    markClass: "Automatic",
    description: "Dual axis: two measures on synchronized/independent axes.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: true,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_bar_line_chart.xml",
  },
  bubble: {
    markClass: "Circle",
    description: "Packed bubbles: dimension on detail/color, measure on size.",
    requiredShelves: ["size", "detail"],
    optionalShelves: ["color", "label", "tooltip"],
    placement: "none",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: false,
    emptyRowsCols: true,
    referenceTemplate: "ws_sample_bubble_chart.xml",
  },
  bar_line_combo: {
    markClass: "Automatic",
    description: "Bar+line combo: two measures, dual axis, mixed marks.",
    requiredShelves: ["columns", "rows"],
    optionalShelves: ["color", "tooltip"],
    placement: "measureOnRows",
    usesColorDimension: false,
    dualMeasureAxes: false,
    dualAxis: true,
    emptyRowsCols: false,
    referenceTemplate: "ws_sample_bar_line_chart.xml",
  },
};

/** Returns the recipe for a chart type. */
export function getChartRecipe(chartType: ChartType): ChartRecipe {
  return CHART_REGISTRY[chartType];
}

/** All supported chart types. */
export function supportedChartTypes(): ChartType[] {
  return Object.keys(CHART_REGISTRY) as ChartType[];
}
