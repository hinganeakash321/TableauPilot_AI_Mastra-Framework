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
import {
  resolvePill,
  plainColumnDecl,
  type PillInput,
  type ResolvedPill,
} from "./columnInstance.js";
import { parameterColumnXml, type ParameterColumn } from "./parameters.js";
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
  // An already-aggregated field is always a measure used as AGG(field).
  const aggregated = info?.aggregated ?? false;
  const role: FieldRole = aggregated
    ? "measure"
    : (spec.role ??
      info?.role ??
      (dataType === "real" || dataType === "integer" ? "measure" : "dimension"));
  const aggregation: Aggregation | undefined =
    role === "measure" && !aggregated
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
    aggregated,
    dateDerivation: spec.dateDerivation,
    continuousDate,
    continuous: spec.continuous,
    format: spec.format ?? info?.defaultFormat,
  };
}

/** Accumulates unique dependency declarations. */
class DependencyBuilder {
  private columns = new Map<string, string>();
  private instances = new Map<string, string>();

  /** `index` lets the builder co-declare a derived field's source columns. */
  constructor(private readonly index?: FieldIndex) {}

  add(pill: ResolvedPill): void {
    if (!this.columns.has(pill.name)) {
      this.columns.set(pill.name, pill.columnDecl);
    }
    if (!this.instances.has(pill.instanceName)) {
      this.instances.set(pill.instanceName, pill.columnInstanceDecl);
    }
    this.addSourceColumns(pill.name);
  }

  /**
   * Declares the source columns a derived field (bin/group/calc) depends on, so
   * Tableau can resolve it. Recurses in case a source is itself derived.
   */
  addSourceColumns(fieldName: string, seen = new Set<string>()): void {
    if (!this.index || seen.has(fieldName)) return;
    seen.add(fieldName);
    const field = this.index.find(fieldName);
    if (!field || field.dependsOn.length === 0) return;
    for (const srcName of field.dependsOn) {
      const src = this.index.find(srcName);
      if (!src) continue;
      if (!this.columns.has(src.name)) {
        this.columns.set(src.name, plainColumnDecl(src));
      }
      this.addSourceColumns(src.name, seen);
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

/**
 * Builds a categorical "keep only these members" filter. A single member is
 * written flat under `<filter>`; multiple members are wrapped in a
 * `<groupfilter function='union'>` (the structure Tableau requires - sibling
 * `member` nodes without a union are invalid and cause open errors).
 */
function buildCategoricalFilter(
  columnRef: string,
  members: { level: string; member: string }[],
  context = false,
): string {
  const ctx = context ? " context='true'" : "";
  const memberEl = (m: { level: string; member: string }, indent: string) =>
    `${indent}<groupfilter function='member' level='${m.level}' member='${m.member}' ` +
    `user:ui-domain='database' user:ui-enumeration='inclusive' user:ui-marker='enumerate' />`;

  if (members.length === 1) {
    return (
      `          <filter class='categorical' column='${columnRef}'${ctx}>\n` +
      memberEl(members[0]!, "            ") +
      `\n          </filter>`
    );
  }
  const inner = members
    .map(
      (m) =>
        `              <groupfilter function='member' level='${m.level}' member='${m.member}' />`,
    )
    .join("\n");
  return (
    `          <filter class='categorical' column='${columnRef}'${ctx}>\n` +
    `            <groupfilter function='union' user:ui-domain='database' user:ui-enumeration='inclusive' user:ui-marker='enumerate'>\n` +
    inner +
    `\n            </groupfilter>\n` +
    `          </filter>`
  );
}

/** Builds a categorical/quantitative or Top-N filter block. */
function buildFilters(
  filters: WorksheetFilterSpec[],
  chartType: ChartType,
  index: FieldIndex,
  dsId: string,
  deps: DependencyBuilder,
  params: Map<string, ParameterColumn> = new Map(),
): {
  filterXml: string;
  sortXml: string;
  sliceXml: string;
  paramColumnsUsed: ParameterColumn[];
} {
  const filterParts: string[] = [];
  const sortParts: string[] = [];
  const sliceCols: string[] = [];
  const paramColumnsUsed: ParameterColumn[] = [];

  for (const f of filters) {
    const ctx = f.context ? " context='true'" : "";
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
      // The N is either a literal or driven by a parameter (`count='[Parameters].
      // [Parameter N]'`), matching the sample workbook's parameterized Top-N.
      let countExpr = String(f.topN.n);
      if (f.topN.nParameter) {
        const p = params.get(f.topN.nParameter.trim().toLowerCase());
        if (p) {
          countExpr = `[Parameters].[${p.name}]`;
          if (!paramColumnsUsed.some((c) => c.name === p.name)) {
            paramColumnsUsed.push(p);
          }
        }
      }
      // The Top-N filter's inner `function='order'` groupfilter both selects AND
      // orders the top/bottom N by the measure. We deliberately do NOT emit a
      // separate `<computed-sort>`: some Tableau runtimes validate the worksheet
      // `<view>` against a stricter schema than the published XSD and reject an
      // in-view `computed-sort` ("no declaration found for element 'computed-sort'"),
      // which makes the whole workbook fail to open. The filter alone keeps the
      // correct N records; the measure pill still drives the ordering.
      filterParts.push(
        `          <filter class='categorical' column='${dimPill.ref(dsId)}'${ctx}>\n` +
          `            <groupfilter count='${countExpr}' end='${end}' function='end' units='records' user:ui-marker='end' user:ui-top-by-field='true'>\n` +
          `              <groupfilter direction='${dir}' expression='${aggFn}([${xmlEscape(measureField)}])' function='order' user:ui-marker='order'>\n` +
          `                <groupfilter function='level-members' level='[${dimPill.instanceName}]' user:ui-manual-selection='true' user:ui-manual-selection-all-when-empty='true' user:ui-marker='enumerate' />\n` +
          `              </groupfilter>\n` +
          `            </groupfilter>\n` +
          `          </filter>`,
      );
      sliceCols.push(`            <column>${dimPill.ref(dsId)}</column>`);
      continue;
    }

    // Value / comparison filter.
    const info = index.find(f.field);
    const isMeasure = info?.role === "measure";
    const dataType: DataType = info?.dataType ?? "string";
    const isDate = dataType === "date" || dataType === "datetime";

    // Date filters target a DISCRETE date part (e.g. yr:Order Date:ok), never the
    // exact date, so the members (years/quarters/months) actually match. Infer a
    // year filter when every value is a 4-digit number and no derivation is given.
    let dateDerivation = f.dateDerivation;
    if (isDate && (!dateDerivation || dateDerivation === "none")) {
      const allYears =
        !!f.values &&
        f.values.length > 0 &&
        f.values.every((v) => /^\d{4}$/.test(String(v)));
      if (allYears) dateDerivation = "year";
    }

    const pill = resolvePill({
      name: info?.name ?? f.field.replace(/^\[/, "").replace(/\]$/, ""),
      role: isMeasure ? "measure" : "dimension",
      dataType,
      aggregation: isMeasure
        ? (info?.defaultAggregation ?? "sum")
        : undefined,
      dateDerivation: isDate ? dateDerivation : undefined,
      // Filters use the discrete (blue) date part, not a continuous truncation.
      continuousDate: false,
    });
    deps.add(pill);

    if (isMeasure && f.values && f.values.length > 0) {
      const nums = f.values.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
      if (nums.length > 0) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
            filterParts.push(
              `          <filter class='quantitative' column='${pill.ref(dsId)}'${ctx} included-values='in-range'>\n` +
                `            <min>${min}</min>\n` +
                `            <max>${max}</max>\n` +
                `          </filter>`,
            );
      }
    } else if (f.values && f.values.length > 0) {
      // Quote string members ("Furniture"); leave numbers/dates/booleans bare
      // (year 2026, month 12), matching how Tableau writes categorical members.
      const quote = dataType === "string";
      const memberLevel = `[${pill.instanceName}]`;
      const memberEls = f.values.map((v) => {
        const val = quote
          ? `&quot;${xmlEscape(String(v))}&quot;`
          : xmlEscape(String(v));
        return { level: memberLevel, member: val };
      });
      filterParts.push(buildCategoricalFilter(pill.ref(dsId), memberEls, !!f.context));
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
    paramColumnsUsed,
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

/**
 * Builds the rows/cols pill reference string for a list of field specs.
 *
 * A shelf is a Tableau EXPRESSION, so multiple pills must be joined by an
 * operator and wrapped in parentheses - bare concatenation
 * (`[a][b]`) makes Tableau fail with "unable to associate operators with
 * operands". Discrete pills join with ` / ` and continuous/measure pills with
 * ` + ` (matching the sample workbook, e.g. `([Category] / [Region])` and
 * `([sum:Discount:qk] + [sum:Profit:qk])`). A single pill is emitted bare.
 */
function buildShelf(
  fields: FieldSpec[],
  chartType: ChartType,
  index: FieldIndex,
  dsId: string,
  deps: DependencyBuilder,
): string {
  const pills = fields.map((fs) => {
    const pill = resolvePill(toPillInput(fs, chartType, index));
    deps.add(pill);
    return pill;
  });
  if (pills.length === 0) return "";
  if (pills.length === 1) return pills[0]!.ref(dsId);
  const allContinuous = pills.every((p) => p.typeAttr === "quantitative");
  const sep = allContinuous ? " + " : " / ";
  return `(${pills.map((p) => p.ref(dsId)).join(sep)})`;
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
  /** Table-level `<style>` block (e.g. measure number format). */
  tableStyleXml?: string;
  rows: string;
  cols: string;
  /** Emit `total='true'` on the `<rows>` shelf (grand total). */
  rowsTotal?: boolean;
  /** Emit `total='true'` on the `<cols>` shelf (grand total). */
  colsTotal?: boolean;
  /** Parameter columns this worksheet depends on (e.g. a Top-N parameter). */
  parameterColumns?: ParameterColumn[];
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

  const paramCols = opts.parameterColumns ?? [];
  const hasParams = paramCols.length > 0;
  const datasourcesXml =
    `          <datasources>\n` +
    `            <datasource caption='${xmlEscape(dsCaption)}' name='${dsId}' />\n` +
    (hasParams ? `            <datasource name='Parameters' />\n` : "") +
    `          </datasources>`;
  const paramDepsXml = hasParams
    ? `          <datasource-dependencies datasource='Parameters'>\n` +
      paramCols.map((p) => parameterColumnXml(p, "            ")).join("\n") +
      `\n          </datasource-dependencies>`
    : "";

  const viewParts = [
    datasourcesXml,
    opts.mapsources
      ? `          <mapsources>\n            <mapsource name='Tableau' />\n          </mapsources>`
      : "",
    paramDepsXml,
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

  const tableStyle = opts.tableStyleXml ? `${opts.tableStyleXml}\n` : `        <style />\n`;
  const rowsAttr = opts.rowsTotal ? " total='true'" : "";
  const colsAttr = opts.colsTotal ? " total='true'" : "";

  return (
    `    <worksheet name='${xmlEscape(name)}'>\n` +
    `      <table>\n` +
    `        <view>\n` +
    viewParts +
    `\n        </view>\n` +
    tableStyle +
    panes +
    `\n        <rows${rowsAttr}>${rows}</rows>\n` +
    `        <cols${colsAttr}>${cols}</cols>\n` +
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
  const deps = new DependencyBuilder(index);
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
  const ref = pill.ref(lock.datasourceId);
  // Formatting mirrors the sample workbook's "Sample KPI Chart": a big bold value
  // (fontsize 18, #1b1b1b) with a smaller bold caption below (fontsize 12), the
  // value referenced via CDATA, the cell centered, and mark labels shown + culled.
  // The line-break run mirrors the sample byte-for-byte: a leading U+00C6 (Æ)
  // followed by the &#10; newline entity. Tableau collapses a run that contains
  // ONLY whitespace/newline, so the value and caption would render on one line;
  // the leading Æ makes the run non-empty so the newline survives (Tableau does
  // not display the Æ itself). Do NOT "clean" this up - it is required.
  const label =
    `            <customized-label>\n` +
    `              <formatted-text>\n` +
    `                <run bold='true' fontcolor='#1b1b1b' fontsize='18'><![CDATA[<${ref}>]]></run>\n` +
    `                <run>\u00C6&#10;</run>\n` +
    `                <run bold='true' fontcolor='#1b1b1b' fontsize='12'>${xmlEscape(title)}</run>\n` +
    `              </formatted-text>\n` +
    `            </customized-label>\n` +
    `            <style>\n` +
    `              <style-rule element='cell'>\n` +
    `                <format attr='text-align' value='center' />\n` +
    `              </style-rule>\n` +
    `              <style-rule element='mark'>\n` +
    `                <format attr='mark-labels-show' value='true' />\n` +
    `                <format attr='mark-labels-cull' value='true' />\n` +
    `              </style-rule>\n` +
    `            </style>\n`;
  const encodings = `              <text column='${ref}' />`;
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
  const deps = new DependencyBuilder(index);
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
  const deps = new DependencyBuilder(index);
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

/**
 * Builds `<encoding attr='color' ... type='palette'>` blocks for any COLOR-shelf
 * field that carries per-member `colors`. These sit inside the pane's
 * `<style-rule element='mark'>` and assign a hex color to each dimension member,
 * exactly like the sample workbook (e.g. `<map to='#499894'><bucket>"Bali"...`).
 * Members without an assignment keep Tableau's automatic palette color.
 */
function buildColorEncodings(
  spec: WorksheetSpec,
  chartType: ChartType,
  index: FieldIndex,
): string {
  const parts: string[] = [];
  for (const mark of spec.marks) {
    for (const enc of mark.encodings) {
      if (enc.shelf !== "color" || !enc.field.colors?.length) continue;
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
      const maps = enc.field.colors
        .map(
          (c) =>
            `                <map to='${xmlEscape(c.color)}'>\n` +
            `                  <bucket>&quot;${xmlEscape(c.value)}&quot;</bucket>\n` +
            `                </map>`,
        )
        .join("\n");
      parts.push(
        `              <encoding attr='color' field='[${pill.instanceName}]' type='palette'>\n` +
          maps +
          `\n              </encoding>`,
      );
    }
  }
  return parts.join("\n");
}

/** Tableau reference-line formula names keyed by our schema's formula enum. */
const REFLINE_FORMULA: Record<string, string> = {
  average: "average",
  median: "median",
  sum: "sum",
  min: "minimum",
  max: "maximum",
  total: "total",
};

/**
 * Builds `<reference-line>` elements for a pane, modeled on the sample workbook's
 * average line. Aggregate lines (average/median/sum/min/max/total) draw at that
 * aggregate of the measure; `constant` draws at a fixed value.
 */
function buildReferenceLines(
  spec: WorksheetSpec,
  chartType: ChartType,
  index: FieldIndex,
  dsId: string,
  deps: DependencyBuilder,
): string {
  const lines = spec.referenceLines ?? [];
  if (!lines.length) return "";
  return lines
    .map((rl, i) => {
      const info = index.find(rl.field);
      const pill = resolvePill(
        toPillInput(
          {
            name: info?.name ?? rl.field,
            role: "measure",
            aggregation: rl.aggregation,
          } as FieldSpec,
          chartType,
          index,
        ),
      );
      deps.add(pill);
      const ref = pill.ref(dsId);
      if (rl.formula === "constant") {
        return (
          `            <reference-line axis-column='${ref}' enable-instant-analytics='true' ` +
          `id='refline${i}' label-type='${rl.labelType}' scope='${rl.scope}' ` +
          `value='${rl.value ?? 0}' z-order='1' />`
        );
      }
      const formula = REFLINE_FORMULA[rl.formula] ?? "average";
      return (
        `            <reference-line axis-column='${ref}' enable-instant-analytics='true' ` +
        `formula='${formula}' id='refline${i}' label-type='${rl.labelType}' scope='${rl.scope}' ` +
        `value-column='${ref}' z-order='1' />`
      );
    })
    .join("\n");
}

/** Generic single-pane compiler covering most chart families. */
function compileGeneric(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  index: FieldIndex,
  params: Map<string, ParameterColumn> = new Map(),
): CompiledWorksheet {
  const dsId = lock.datasourceId;
  const recipe = getChartRecipe(spec.chartType);
  const deps = new DependencyBuilder(index);

  const { filterXml, sortXml, sliceXml, paramColumnsUsed } = buildFilters(
    spec.filters,
    spec.chartType,
    index,
    dsId,
    deps,
    params,
  );
  const encodingsXml = buildEncodings(spec, spec.chartType, index, dsId, deps);

  const rows = recipe.emptyRowsCols
    ? ""
    : buildShelf(spec.rows, spec.chartType, index, dsId, deps);
  const cols = recipe.emptyRowsCols
    ? ""
    : buildShelf(spec.columns, spec.chartType, index, dsId, deps);

  // Value labels + number formatting, matching the sample workbook. The sample
  // shows mark labels on the primary measure for bar-family charts (and any chart
  // when the user asks). We add a measure text label, the `mark-labels-show/cull`
  // pane style, and a table-level cell number format for that measure.
  const measureFieldSpec = [...spec.rows, ...spec.columns].find(
    (f) => (index.find(f.name)?.role ?? f.role) === "measure",
  );
  const measurePill = measureFieldSpec
    ? resolvePill(toPillInput({ ...measureFieldSpec, role: "measure" }, spec.chartType, index))
    : undefined;
  const measureFormat = measureFieldSpec
    ? measureFieldSpec.format ?? index.find(measureFieldSpec.name)?.defaultFormat
    : undefined;

  const hasLabelEncoding = spec.marks.some((m) =>
    m.encodings.some((e) => e.shelf === "label"),
  );
  const wantLabels = spec.formatting?.showLabels ?? recipe.showsValueLabels ?? false;
  const showLabels = (wantLabels || hasLabelEncoding) && !recipe.emptyRowsCols;

  let extraLabelXml = "";
  if (showLabels && !hasLabelEncoding && measurePill) {
    deps.add(measurePill);
    extraLabelXml = `              <text column='${measurePill.ref(dsId)}' />`;
  }
  const allEncodingsXml = [encodingsXml, extraLabelXml].filter(Boolean).join("\n");

  // Pane `<style>` = a single `<style-rule element='mark'>` holding any per-member
  // color palette encodings followed by the mark-label formats (matching the
  // sample workbook's structure).
  const colorEncodingsXml = buildColorEncodings(spec, spec.chartType, index);
  const labelFormatsXml = showLabels
    ? `              <format attr='mark-labels-show' value='true' />\n` +
      `              <format attr='mark-labels-cull' value='true' />`
    : "";
  const markRuleInner = [colorEncodingsXml, labelFormatsXml]
    .filter(Boolean)
    .join("\n");
  const paneStyleXml = markRuleInner
    ? `            <style>\n` +
      `              <style-rule element='mark'>\n` +
      markRuleInner +
      `\n              </style-rule>\n` +
      `            </style>\n`
    : undefined;

  // Reference/average lines sit under the pane, after encodings, before <style>.
  const reflineXml = buildReferenceLines(spec, spec.chartType, index, dsId, deps);
  const paneExtraXml = [reflineXml, paneStyleXml?.replace(/\n$/, "")]
    .filter(Boolean)
    .join("\n");

  const tableStyleXml =
    showLabels && measurePill && measureFormat
      ? `        <style>\n` +
        `          <style-rule element='cell'>\n` +
        `            <format attr='text-format' field='${measurePill.ref(dsId)}' value='${xmlEscape(measureFormat)}' />\n` +
        `          </style-rule>\n` +
        `        </style>`
      : undefined;

  const worksheetXml = assembleWorksheet({
    name: spec.name,
    dsId,
    dsCaption: lock.datasourceName,
    deps,
    filterXml,
    sortXml,
    sliceXml,
    markClass: recipe.markClass,
    encodingsXml: allEncodingsXml,
    paneExtraXml: paneExtraXml || undefined,
    tableStyleXml,
    rows,
    cols,
    rowsTotal: spec.grandTotals?.row ?? false,
    colsTotal: spec.grandTotals?.column ?? false,
    parameterColumns: paramColumnsUsed,
  });
  return { name: spec.name, worksheetXml, windowXml: buildWindow(spec.name) };
}

/**
 * Injects a `<layout-options><title>` block (formatted sheet title) right after
 * the `<worksheet name=...>` open tag when the spec provides a titleFormat. This
 * is what formats the title shown on the sheet AND on any dashboard. Only emitted
 * when a titleFormat is present, so default worksheets are unchanged.
 */
function injectTitleLayout(worksheetXml: string, spec: WorksheetSpec): string {
  const fmt = spec.formatting?.titleFormat;
  if (!fmt) return worksheetXml;
  const titleText = spec.formatting?.title ?? spec.name;
  const align =
    fmt.alignment === "center" ? "1" : fmt.alignment === "right" ? "2" : "0";
  const bold = fmt.bold ? "bold='true' " : "";
  const color = fmt.color ?? "#000000";
  const fontName = fmt.fontName ?? "Tableau Book";
  const fontSize = fmt.fontSize ?? 12;
  const run =
    `<run ${bold}fontalignment='${align}' fontcolor='${xmlEscape(color)}' ` +
    `fontname='${xmlEscape(fontName)}' fontsize='${fontSize}'>${xmlEscape(titleText)}</run>`;
  const block =
    `      <layout-options>\n` +
    `        <title>\n` +
    `          <formatted-text>\n` +
    `            ${run}\n` +
    `          </formatted-text>\n` +
    `        </title>\n` +
    `      </layout-options>\n`;
  return worksheetXml.replace(
    /(<worksheet name='(?:[^']*)'>\n)/,
    `$1${block}`,
  );
}

/**
 * Compiles a WorksheetSpec into a worksheet + window XML pair. Dispatches to the
 * specialized builder for KPI, dual-axis, and map charts.
 *
 * `params` are the workbook's parameter columns (existing + newly created) so a
 * Top-N filter driven by a parameter can reference `[Parameters].[Parameter N]`.
 */
export function compileWorksheet(
  spec: WorksheetSpec,
  lock: DatasourceLock,
  fields: FieldInfo[],
  params: ParameterColumn[] = [],
): CompiledWorksheet {
  const index = new FieldIndex(fields);
  const paramMap = new Map(params.map((p) => [p.caption.trim().toLowerCase(), p]));
  let compiled: CompiledWorksheet;
  switch (spec.chartType) {
    case "kpi":
      compiled = compileKpi(spec, lock, index);
      break;
    case "dual_line":
    case "dual_axis":
    case "bar_line_combo":
      compiled = compileDual(spec, lock, index);
      break;
    case "map":
    case "symbol_map":
    case "filled_map":
      compiled = compileMap(spec, lock, index);
      break;
    default:
      compiled = compileGeneric(spec, lock, index, paramMap);
  }
  return {
    ...compiled,
    worksheetXml: injectTitleLayout(compiled.worksheetXml, spec),
  };
}
