/**
 * Deterministic worksheet compiler.
 *
 * Converts a validated {@link WorksheetSpec} into real Tableau worksheet XML plus
 * the matching `<window>` registration entry, modeled on the patterns in the
 * sample workbook. The LLM never produces this XML (spec section 39).
 */

import { randomUUID } from "node:crypto";
import type {
  ChartType,
  FieldSpec,
  Shelf,
  WorksheetFilterSpec,
  WorksheetSpec,
} from "../../mastra/schemas/worksheet.js";
import type { FieldInfo } from "../../mastra/schemas/workbook.js";
import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type {
  Aggregation,
  DataType,
  FieldRole,
} from "../../mastra/schemas/common.js";
import { getChartRecipe } from "../../../templates/registry/index.js";
import { resolvePill, type PillInput, type ResolvedPill } from "./columnInstance.js";
import { xmlEscape } from "../xml.js";

/** Result of compiling one worksheet. */
export interface CompiledWorksheet {
  name: string;
  worksheetXml: string;
  windowXml: string;
}

/** Chart families whose date axis is continuous (green). */
const CONTINUOUS_DATE_CHARTS: ReadonlySet<ChartType> = new Set<ChartType>([
  "line",
  "area",
  "dual_line",
  "dual_axis",
  "bar_line_combo",
]);

/** Encoding shelf -> Tableau encoding element name. */
const ENCODING_ELEMENT: Partial<Record<Shelf, string>> = {
  color: "color",
  size: "size",
  label: "text",
  detail: "lod",
  shape: "shape",
  angle: "wedge-size",
  path: "path",
};

/** Case-insensitive field lookup helper. */
export class FieldIndex {
  private byName = new Map<string, FieldInfo>();
  private byCaption = new Map<string, FieldInfo>();

  constructor(fields: FieldInfo[]) {
    for (const f of fields) {
      this.byName.set(f.name.toLowerCase(), f);
      if (f.caption) this.byCaption.set(f.caption.toLowerCase(), f);
    }
  }

  find(name: string): FieldInfo | undefined {
    const key = name.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    return this.byName.get(key) ?? this.byCaption.get(key);
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  allNames(): string[] {
    return [...this.byName.values()].map((f) => f.name);
  }
}

/** Resolves a FieldSpec into a concrete PillInput using datasource metadata. */
function toPillInput(
  spec: FieldSpec,
  chartType: ChartType,
  index: FieldIndex,
): PillInput {
  const info = index.find(spec.name);
  const dataType: DataType = spec.dataType ?? info?.dataType ?? "string";
  const role: FieldRole =
    spec.role ??
    info?.role ??
    (dataType === "real" || dataType === "integer" ? "measure" : "dimension");
  const aggregation: Aggregation | undefined =
    role === "measure"
      ? (spec.aggregation && spec.aggregation !== "none"
          ? spec.aggregation
          : (info?.defaultAggregation ?? "sum"))
      : undefined;
  const continuousDate =
    (dataType === "date" || dataType === "datetime") &&
    CONTINUOUS_DATE_CHARTS.has(chartType);
  return {
    name: info?.name ?? spec.name.replace(/^\[/, "").replace(/\]$/, ""),
    role,
    dataType,
    aggregation,
    dateDerivation: spec.dateDerivation,
    continuousDate,
    format: spec.format ?? info?.defaultFormat,
  };
}

/** Accumulates unique dependency declarations. */
class DependencyBuilder {
  private columns = new Map<string, string>();
  private instances = new Map<string, string>();

  add(pill: ResolvedPill): void {
    if (!this.columns.has(pill.name)) {
      this.columns.set(pill.name, pill.columnDecl);
    }
    if (!this.instances.has(pill.instanceName)) {
      this.instances.set(pill.instanceName, pill.columnInstanceDecl);
    }
  }

  render(dsId: string): string {
    const cols = [...this.columns.values()].map((c) => `            ${c}`);
    const insts = [...this.instances.values()].map((c) => `            ${c}`);
    return (
      `          <datasource-dependencies datasource='${dsId}'>\n` +
      [...cols, ...insts].join("\n") +
      `\n          </datasource-dependencies>`
    );
  }
}

/** Builds a categorical/quantitative or Top-N filter block. */
function buildFilters(
  filters: WorksheetFilterSpec[],
  chartType: ChartType,
  index: FieldIndex,
  dsId: string,
  deps: DependencyBuilder,
): { filterXml: string; sortXml: string; sliceXml: string } {
  const filterParts: string[] = [];
  const sortParts: string[] = [];
  const sliceCols: string[] = [];

  for (const f of filters) {
    if (f.topN) {
      const dimInfo = index.find(f.topN.field);
      const dimPill = resolvePill(
        toPillInput(
          { name: f.topN.field, role: "dimension", dataType: dimInfo?.dataType },
          chartType,
          index,
        ),
      );
      deps.add(dimPill);
      const measurePill = resolvePill(
        toPillInput(
          {
            name: f.topN.byMeasure,
            role: "measure",
            aggregation: f.topN.measureAggregation,
          },
          chartType,
          index,
        ),
      );
      deps.add(measurePill);
      const end = f.topN.direction === "top" ? "top" : "bottom";
      const dir = f.topN.direction === "top" ? "DESC" : "ASC";
      const aggFn = (f.topN.measureAggregation ?? "sum").toUpperCase();
      const measureField = index.find(f.topN.byMeasure)?.name ?? f.topN.byMeasure;
      filterParts.push(
        `          <filter class='categorical' column='${dimPill.ref(dsId)}'>\n` +
          `            <groupfilter count='${f.topN.n}' end='${end}' function='end' units='records' user:ui-marker='end' user:ui-top-by-field='true'>\n` +
          `              <groupfilter direction='${dir}' expression='${aggFn}([${xmlEscape(measureField)}])' function='order' user:ui-marker='order'>\n` +
          `                <groupfilter function='level-members' level='[${dimPill.instanceName}]' user:ui-marker='enumerate' />\n` +
          `              </groupfilter>\n` +
          `            </groupfilter>\n` +
          `          </filter>`,
      );
      sortParts.push(
        `          <computed-sort column='${dimPill.ref(dsId)}' direction='${dir}' using='${measurePill.ref(dsId)}' />`,
      );
      sliceCols.push(`            <column>${dimPill.ref(dsId)}</column>`);
      continue;
    }

    // Value / comparison filter.
    const info = index.find(f.field);
    const isMeasure = info?.role === "measure";
    const pill = resolvePill(
      toPillInput(
        {
          name: f.field,
          role: isMeasure ? "measure" : "dimension",
          dataType: info?.dataType,
        },
        chartType,
        index,
      ),
    );
    deps.add(pill);

    if (isMeasure && f.values && f.values.length > 0) {
      const nums = f.values.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
      if (nums.length > 0) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        filterParts.push(
          `          <filter class='quantitative' column='${pill.ref(dsId)}' included-values='in-range'>\n` +
            `            <min>${min}</min>\n` +
            `            <max>${max}</max>\n` +
            `          </filter>`,
        );
      }
    } else if (f.values && f.values.length > 0) {
      const members = f.values
        .map(
          (v) =>
            `            <groupfilter function='member' level='[${pill.instanceName}]' member='&quot;${xmlEscape(String(v))}&quot;' user:ui-marker='enumerate' />`,
        )
        .join("\n");
      filterParts.push(
        `          <filter class='categorical' column='${pill.ref(dsId)}'>\n` +
          members +
          `\n          </filter>`,
      );
      sliceCols.push(`            <column>${pill.ref(dsId)}</column>`);
    }
  }

  const sliceXml =
    sliceCols.length > 0
      ? `          <slices>\n${sliceCols.join("\n")}\n          </slices>`
      : "";
  return {
    filterXml: filterParts.join("\n"),
    sortXml: sortParts.join("\n"),
    sliceXml,
  };
}

/** Renders encoding elements for a pane, adding referenced fields to deps. */
function buildEncodings(
  spec: WorksheetSpec,
  chartType: ChartType,
  index: FieldIndex,
  dsId: string,
  deps: DependencyBuilder,
): string {
  const parts: string[] = [];
  for (const mark of spec.marks) {
    for (const enc of mark.encodings) {
      const element = ENCODING_ELEMENT[enc.shelf];
      if (!element) continue; // rows/columns/tooltip handled elsewhere
      const info = index.find(enc.field.name);
      const pill = resolvePill(
        toPillInput(
          {
            ...enc.field,
            role: enc.field.role ?? info?.role,
            dataType: enc.field.dataType ?? info?.dataType,
          } as FieldSpec,
          chartType,
          index,
        ),
      );
      deps.add(pill);
      parts.push(`              <${element} column='${pill.ref(dsId)}' />`);
    }
  }
  return parts.join("\n");
}

/** Builds the rows/cols pill reference string for a list of field specs. */
function buildShelf(
  fields: FieldSpec[],
  chartType: ChartType,
  index: FieldIndex,
  dsId: string,
  deps: DependencyBuilder,
): string {
  return fields
    .map((fs) => {
      const pill = resolvePill(toPillInput(fs, chartType, index));
      deps.add(pill);
      return pill.ref(dsId);
    })
    .join("");
}

/** Builds the `<window>` registration entry for a worksheet. */
function buildWindow(name: string): string {
  return (
    `    <window class='worksheet' name='${xmlEscape(name)}'>\n` +
    `      <cards>\n` +
    `        <edge name='left'>\n` +
    `          <strip size='160'>\n` +
    `            <card type='pages' />\n` +
    `            <card type='filters' />\n` +
    `            <card type='marks' />\n` +
    `          </strip>\n` +
    `        </edge>\n` +
    `        <edge name='top'>\n` +
    `          <strip size='2147483647'>\n` +
    `            <card type='columns' />\n` +
    `          </strip>\n` +
    `          <strip size='2147483647'>\n` +
    `            <card type='rows' />\n` +
    `          </strip>\n` +
    `          <strip size='31'>\n` +
    `            <card type='title' />\n` +
    `          </strip>\n` +
    `        </edge>\n` +
    `      </cards>\n` +
    `      <viewpoint>\n` +
    `        <zoom type='entire-view' />\n` +
    `      </viewpoint>\n` +
    `      <simple-id uuid='{${randomUUID().toUpperCase()}}' />\n` +
    `    </window>`
  );
}

/** Assembles a complete `<worksheet>` element from parts. */
function assembleWorksheet(opts: {
  name: string;
  dsId: string;
  dsCaption: string;
  deps: DependencyBuilder;
  filterXml: string;
  sortXml: string;
  sliceXml: string;
  markClass: string;
  encodingsXml: string;
  paneExtraXml?: string;
  panesOverrideXml?: string;
  rows: string;
  cols: string;
  mapsources?: boolean;
}): string {
  const {
    name,
    dsId,
    dsCaption,
    deps,
    filterXml,
    sortXml,
    sliceXml,
    markClass,
    encodingsXml,
    rows,
    cols,
  } = opts;

  const viewParts = [
    `          <datasources>\n            <datasource caption='${xmlEscape(dsCaption)}' name='${dsId}' />\n          </datasources>`,
    opts.mapsources
      ? `          <mapsources>\n            <mapsource name='Tableau' />\n          </mapsources>`
      : "",
    deps.render(dsId),
    filterXml,
    sortXml,
    sliceXml,
    `          <aggregation value='true' />`,
  ]
    .filter(Boolean)
    .join("\n");

  const panes =
    opts.panesOverrideXml ??
    `        <panes>\n` +
      `          <pane selection-relaxation-option='selection-relaxation-allow'>\n` +
      `            <view>\n              <breakdown value='auto' />\n            </view>\n` +
      `            <mark class='${markClass}' />\n` +
      (encodingsXml
        ? `            <encodings>\n${encodingsXml}\n            </encodings>\n`
        : "") +
      (opts.paneExtraXml ?? "") +
      `          </pane>\n` +
      `        </panes>`;

  return (
    `    <worksheet name='${xmlEscape(name)}'>\n` +
    `      <table>\n` +
    `        <view>\n` +
    viewParts +
    `\n        </view>\n` +
    `        <style />\n` +
    panes +
    `\n        <rows>${rows}</rows>\n` +
    `        <cols>${cols}</cols>\n` +
    `      </table>\n` +
    `      <simple-id uuid='{${randomUUID().toUpperCase()}}' />\n` +
    `    </worksheet>`
  );
}

/** Compiles a KPI worksheet (single measure as big text). */
function compileKpi(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  index: FieldIndex,
): CompiledWorksheet {
  const deps = new DependencyBuilder();
  // The measure is taken from the first label encoding, or first row/column measure.
  const measureSpec =
    spec.marks.flatMap((m) => m.encodings).find((e) => e.shelf === "label")
      ?.field ??
    [...spec.rows, ...spec.columns].find((f) => (index.find(f.name)?.role ?? f.role) === "measure") ??
    spec.rows[0] ??
    spec.columns[0];
  if (!measureSpec) {
    throw new Error("KPI worksheet requires at least one measure");
  }
  const pill = resolvePill(
    toPillInput({ ...measureSpec, role: "measure" }, "kpi", index),
  );
  deps.add(pill);
  const title = spec.formatting?.title ?? spec.name;
  const label =
    `            <customized-label>\n` +
    `              <formatted-text>\n` +
    `                <run bold='true' fontsize='18'>&lt;${pill.ref(lock.datasourceId)}&gt;</run>\n` +
    `                <run>&#10;</run>\n` +
    `                <run bold='true' fontsize='12'>${xmlEscape(title)}</run>\n` +
    `              </formatted-text>\n` +
    `            </customized-label>\n` +
    `            <style>\n` +
    `              <style-rule element='mark'>\n` +
    `                <format attr='mark-labels-show' value='true' />\n` +
    `              </style-rule>\n` +
    `            </style>\n`;
  const encodings = `              <text column='${pill.ref(lock.datasourceId)}' />`;
  const worksheetXml = assembleWorksheet({
    name: spec.name,
    dsId: lock.datasourceId,
    dsCaption: lock.datasourceName,
    deps,
    filterXml: "",
    sortXml: "",
    sliceXml: "",
    markClass: "Automatic",
    encodingsXml: encodings,
    paneExtraXml: label,
    rows: "",
    cols: "",
  });
  return { name: spec.name, worksheetXml, windowXml: buildWindow(spec.name) };
}

/** Compiles a dual-axis chart (two measures via Measure Names). */
function compileDual(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  index: FieldIndex,
): CompiledWorksheet {
  const dsId = lock.datasourceId;
  const deps = new DependencyBuilder();
  const measures = [...spec.rows, ...spec.marks.flatMap((m) => m.encodings.map((e) => e.field))].filter(
    (f) => (index.find(f.name)?.role ?? f.role) === "measure",
  );
  const dateCol = spec.columns[0];
  if (measures.length < 2 || !dateCol) {
    // Fallback to generic if not enough info for a real dual axis.
    return compileGeneric(spec, lock, index);
  }
  const m1 = resolvePill(toPillInput({ ...measures[0]!, role: "measure" }, spec.chartType, index));
  const m2 = resolvePill(toPillInput({ ...measures[1]!, role: "measure" }, spec.chartType, index));
  const dPill = resolvePill(toPillInput(dateCol, spec.chartType, index));
  deps.add(m1);
  deps.add(m2);
  deps.add(dPill);

  const measureNames = `[${dsId}].[:Measure Names]`;
  const paneColor = `            <encodings>\n              <color column='${measureNames}' />\n            </encodings>\n`;
  const panes =
    `        <panes>\n` +
    `          <pane selection-relaxation-option='selection-relaxation-allow'>\n` +
    `            <view>\n              <breakdown value='auto' />\n            </view>\n` +
    `            <mark class='${getChartRecipe(spec.chartType).markClass}' />\n` +
    paneColor +
    `          </pane>\n` +
    `          <pane id='1' selection-relaxation-option='selection-relaxation-allow' y-axis-name='${m1.ref(dsId)}'>\n` +
    `            <view>\n              <breakdown value='auto' />\n            </view>\n` +
    `            <mark class='${getChartRecipe(spec.chartType).markClass}' />\n` +
    paneColor +
    `          </pane>\n` +
    `          <pane id='2' selection-relaxation-option='selection-relaxation-allow' y-axis-name='${m2.ref(dsId)}'>\n` +
    `            <view>\n              <breakdown value='auto' />\n            </view>\n` +
    `            <mark class='${getChartRecipe(spec.chartType).markClass}' />\n` +
    paneColor +
    `          </pane>\n` +
    `        </panes>`;

  const rows = `(${m1.ref(dsId)} + ${m2.ref(dsId)})`;
  const worksheetXml = assembleWorksheet({
    name: spec.name,
    dsId,
    dsCaption: lock.datasourceName,
    deps,
    filterXml: "",
    sortXml: "",
    sliceXml: "",
    markClass: getChartRecipe(spec.chartType).markClass,
    encodingsXml: "",
    panesOverrideXml: panes,
    rows,
    cols: dPill.ref(dsId),
  });
  return { name: spec.name, worksheetXml, windowXml: buildWindow(spec.name) };
}

/** Compiles a map worksheet using generated Lat/Long. */
function compileMap(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  index: FieldIndex,
): CompiledWorksheet {
  const dsId = lock.datasourceId;
  const deps = new DependencyBuilder();
  const encodings = buildEncodings(spec, spec.chartType, index, dsId, deps);
  // Geographic dimensions go to detail (lod) if not already encoded.
  const geoDims = spec.rows.concat(spec.columns).filter((f) => {
    const info = index.find(f.name);
    return info && info.role === "dimension";
  });
  const extraLod = geoDims
    .map((f) => {
      const pill = resolvePill(toPillInput(f, spec.chartType, index));
      deps.add(pill);
      return `              <lod column='${pill.ref(dsId)}' />`;
    })
    .join("\n");
  const allEncodings = [encodings, extraLod].filter(Boolean).join("\n");
  const worksheetXml = assembleWorksheet({
    name: spec.name,
    dsId,
    dsCaption: lock.datasourceName,
    deps,
    filterXml: "",
    sortXml: "",
    sliceXml: "",
    markClass: getChartRecipe(spec.chartType).markClass,
    encodingsXml: allEncodings,
    rows: `[${dsId}].[Latitude (generated)]`,
    cols: `[${dsId}].[Longitude (generated)]`,
    mapsources: true,
  });
  return { name: spec.name, worksheetXml, windowXml: buildWindow(spec.name) };
}

/** Generic single-pane compiler covering most chart families. */
function compileGeneric(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  index: FieldIndex,
): CompiledWorksheet {
  const dsId = lock.datasourceId;
  const recipe = getChartRecipe(spec.chartType);
  const deps = new DependencyBuilder();

  const { filterXml, sortXml, sliceXml } = buildFilters(
    spec.filters,
    spec.chartType,
    index,
    dsId,
    deps,
  );
  const encodingsXml = buildEncodings(spec, spec.chartType, index, dsId, deps);

  const rows = recipe.emptyRowsCols
    ? ""
    : buildShelf(spec.rows, spec.chartType, index, dsId, deps);
  const cols = recipe.emptyRowsCols
    ? ""
    : buildShelf(spec.columns, spec.chartType, index, dsId, deps);

  const worksheetXml = assembleWorksheet({
    name: spec.name,
    dsId,
    dsCaption: lock.datasourceName,
    deps,
    filterXml,
    sortXml,
    sliceXml,
    markClass: recipe.markClass,
    encodingsXml,
    rows,
    cols,
  });
  return { name: spec.name, worksheetXml, windowXml: buildWindow(spec.name) };
}

/**
 * Compiles a WorksheetSpec into a worksheet + window XML pair. Dispatches to the
 * specialized builder for KPI, dual-axis, and map charts.
 */
export function compileWorksheet(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  fields: FieldInfo[],
): CompiledWorksheet {
  const index = new FieldIndex(fields);
  switch (spec.chartType) {
    case "kpi":
      return compileKpi(spec, lock, index);
    case "dual_line":
    case "dual_axis":
    case "bar_line_combo":
      return compileDual(spec, lock, index);
    case "map":
    case "symbol_map":
    case "filled_map":
      return compileMap(spec, lock, index);
    default:
      return compileGeneric(spec, lock, index);
  }
}
