/**
 * Deterministic dashboard compiler.
 *
 * Converts a validated {@link DashboardSpec} into real Tableau dashboard XML plus
 * the matching `<window class='dashboard'>` entry, modeled on the two sample
 * dashboards in the sample workbook (see `sample_dashboard_analysis.md`). The LLM
 * never produces this XML.
 *
 * Layout: a structurally-faithful zone tree (title band -> chart grid + right
 * Filters panel) with clean proportional coordinates in Tableau's 0-100000 space.
 * Tableau recomputes flow-zone geometry on open, so exact pixel coordinates are
 * not required - only a valid, consistently-tiled tree.
 */

import { randomUUID } from "node:crypto";
import type { DashboardSpec } from "../../mastra/schemas/dashboard.js";
import type { FieldInfo } from "../../mastra/schemas/workbook.js";
import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type {
  DataType,
  TextFormat,
  BorderSpec,
} from "../../mastra/schemas/common.js";
import { resolvePill, plainColumnDecl } from "./columnInstance.js";
import { FieldIndex } from "./worksheetCompiler.js";
import type { ParameterColumn } from "./parameters.js";
import { xmlEscape } from "../xml.js";

/** A dashboard filter field resolved to its Tableau column-instance. */
export interface ResolvedFilterField {
  field: string;
  /** Raw column name without brackets, e.g. `Region` or `Order Date`. */
  columnName: string;
  /** Instance name without brackets, e.g. `none:Region:nk` or `yr:Order Date:ok`. */
  instanceName: string;
  /** Shelf/param reference `[dsId].[instance]`. */
  ref: string;
  /** `<column .../>` declaration for datasource-dependencies. */
  columnDecl: string;
  /** `<column-instance .../>` declaration for datasource-dependencies. */
  columnInstanceDecl: string;
  /**
   * Plain `<column .../>` declarations for the SOURCE columns this field derives
   * from (bin/group/calc). Must be co-declared so Tableau can resolve the field.
   * Empty for plain physical columns.
   */
  sourceColumnDecls: string[];
  dataType: DataType;
  isDate: boolean;
  /** Filter control value scope (relevant | database). */
  values: "relevant" | "database";
}

/** Result of compiling one dashboard. */
export interface CompiledDashboard {
  name: string;
  dashboardXml: string;
  windowXml: string;
  filterFields: ResolvedFilterField[];
  referencedWorksheets: string[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Monotonic zone-id allocator for a single dashboard. */
class ZoneIds {
  private n = 3;
  next(): number {
    this.n += 1;
    return this.n;
  }
}

/** Splits a rect vertically by weights (top to bottom); last absorbs remainder. */
function partitionV(rect: Rect, weights: number[]): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Rect[] = [];
  let y = rect.y;
  let used = 0;
  weights.forEach((wgt, i) => {
    const isLast = i === weights.length - 1;
    const h = isLast ? rect.h - used : Math.round((rect.h * wgt) / total);
    out.push({ x: rect.x, y, w: rect.w, h });
    y += h;
    used += h;
  });
  return out;
}

/** Splits a rect horizontally by weights (left to right); last absorbs remainder. */
function partitionH(rect: Rect, weights: number[]): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Rect[] = [];
  let x = rect.x;
  let used = 0;
  weights.forEach((wgt, i) => {
    const isLast = i === weights.length - 1;
    const w = isLast ? rect.w - used : Math.round((rect.w * wgt) / total);
    out.push({ x, y: rect.y, w, h: rect.h });
    x += w;
    used += w;
  });
  return out;
}

/** Border format lines for a zone-style (defaults to no border). */
function borderLines(indent: string, border?: BorderSpec): string {
  const color = border?.color ?? "#000000";
  const style = border?.style ?? "none";
  const width = border?.width ?? 0;
  return (
    `${indent}<format attr='border-color' value='${xmlEscape(color)}' />\n` +
    `${indent}<format attr='border-style' value='${style}' />\n` +
    `${indent}<format attr='border-width' value='${width}' />`
  );
}

/** Common leaf zone-style (border + inner-padding margin). */
function leafStyle(indent: string, margin: number, border?: BorderSpec): string {
  return (
    `${indent}<zone-style>\n` +
    borderLines(`${indent}  `, border) +
    `\n${indent}  <format attr='margin' value='${margin}' />\n` +
    `${indent}</zone-style>`
  );
}

/** Container zone-style with a background color (+ border + inner padding). */
function containerStyle(
  indent: string,
  bg: string,
  margin: number,
  border?: BorderSpec,
): string {
  return (
    `${indent}<zone-style>\n` +
    borderLines(`${indent}  `, border) +
    `\n${indent}  <format attr='margin' value='${margin}' />\n` +
    `${indent}  <format attr='background-color' value='${xmlEscape(bg)}' />\n` +
    `${indent}</zone-style>`
  );
}

/**
 * Builds the dashboard `<size>` element for the chosen sizing mode.
 * - automatic: `<size sizing-mode='automatic' />` (no bounds).
 * - fixed: exact size (min == max == width/height; default 1200x1200).
 * - range: scales between (minWidth x minHeight) and (maxWidth x maxHeight);
 *   sensible defaults fill any omitted bound and are clamped so max >= min.
 */
function buildSizeXml(spec: DashboardSpec): string {
  if (spec.sizeMode === "fixed") {
    const w = spec.width ?? 1200;
    const h = spec.height ?? 1200;
    return (
      `      <size maxheight='${h}' maxwidth='${w}' minheight='${h}' ` +
      `minwidth='${w}' sizing-mode='fixed' />`
    );
  }
  if (spec.sizeMode === "range") {
    const minW = spec.minWidth ?? 800;
    const minH = spec.minHeight ?? 600;
    const maxW = Math.max(spec.maxWidth ?? 1200, minW);
    const maxH = Math.max(spec.maxHeight ?? 900, minH);
    return (
      `      <size maxheight='${maxH}' maxwidth='${maxW}' minheight='${minH}' ` +
      `minwidth='${minW}' sizing-mode='range' />`
    );
  }
  return `      <size sizing-mode='automatic' />`;
}

/** Builds a formatted-text `<run ...>` open tag from a TextFormat + defaults. */
function runOpen(
  fmt: TextFormat | undefined,
  defaults: {
    bold: boolean;
    alignment: "left" | "center" | "right";
    color: string;
    fontName: string;
    fontSize: number;
  },
): string {
  const bold = fmt?.bold ?? defaults.bold;
  const alignment = fmt?.alignment ?? defaults.alignment;
  const color = fmt?.color ?? defaults.color;
  const fontName = fmt?.fontName ?? defaults.fontName;
  const fontSize = fmt?.fontSize ?? defaults.fontSize;
  const alignNum = alignment === "left" ? "0" : alignment === "right" ? "2" : "1";
  const boldAttr = bold ? "bold='true' " : "";
  return (
    `<run ${boldAttr}fontalignment='${alignNum}' fontcolor='${xmlEscape(color)}' ` +
    `fontname='${xmlEscape(fontName)}' fontsize='${fontSize}'>`
  );
}

/** `x/y/w/h` attribute string for a zone. */
function dims(r: Rect): string {
  return `h='${r.h}' w='${r.w}' x='${r.x}' y='${r.y}'`;
}

/** Resolves a dashboard filter field to its column-instance + decls. */
function resolveFilterField(
  field: string,
  index: FieldIndex,
  dsId: string,
  values: "relevant" | "database",
): ResolvedFilterField {
  const info = index.find(field);
  const dataType: DataType = info?.dataType ?? "string";
  const isDate = dataType === "date" || dataType === "datetime";
  const columnName = info?.name ?? field.replace(/^\[/, "").replace(/\]$/, "");
  const pill = resolvePill({
    name: columnName,
    role: "dimension",
    dataType,
    // Date filters use a discrete YEAR part for the dropdown by default.
    dateDerivation: isDate ? "year" : undefined,
    continuousDate: false,
  });
  // Co-declare source columns for derived fields (bins/groups/calcs), so the
  // filtered field resolves in every worksheet. Recurses through nested sources.
  const sourceColumnDecls: string[] = [];
  const seen = new Set<string>();
  const collectSources = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const f = index.find(name);
    if (!f) return;
    for (const srcName of f.dependsOn) {
      const src = index.find(srcName);
      if (!src) continue;
      const decl = plainColumnDecl(src);
      if (!sourceColumnDecls.includes(decl)) sourceColumnDecls.push(decl);
      collectSources(src.name);
    }
  };
  collectSources(columnName);

  return {
    field,
    columnName,
    instanceName: pill.instanceName,
    ref: pill.ref(dsId),
    columnDecl: pill.columnDecl,
    columnInstanceDecl: pill.columnInstanceDecl,
    sourceColumnDecls,
    dataType,
    isDate,
    // Relevant-values doesn't apply cleanly to a date part, so dates use database.
    values: isDate ? "database" : values,
  };
}

/**
 * Compiles a DashboardSpec into a dashboard + window XML pair. Validates that
 * every referenced worksheet exists and every filter field is a real field.
 */
export function compileDashboard(
  spec: DashboardSpec,
  lock: DatasourceLock,
  fields: FieldInfo[],
  existingWorksheetNames: string[],
  /**
   * Every parameter column available in the workbook (from the Parameters
   * datasource). Used to resolve a requested parameter display name to its
   * internal `[Parameters].[Parameter N]` reference for the filter panel.
   */
  parameterColumns: ParameterColumn[] = [],
): CompiledDashboard {
  const dsId = lock.datasourceId;
  const index = new FieldIndex(fields);
  const existing = new Set(existingWorksheetNames);

  const referencedWorksheets = spec.rows.flatMap((r) =>
    r.sheets.map((s) => s.worksheet),
  );
  for (const name of referencedWorksheets) {
    if (!existing.has(name)) {
      throw new Error(
        `Dashboard '${spec.name}' references worksheet '${name}' which does not exist.`,
      );
    }
  }

  const filterCfg = spec.filters;
  const filterFields: ResolvedFilterField[] = (filterCfg?.fields ?? []).map(
    (f) => {
      if (!index.has(f)) {
        throw new Error(
          `Dashboard '${spec.name}' filter field '${f}' does not exist in the datasource.`,
        );
      }
      return resolveFilterField(f, index, dsId, filterCfg?.values ?? "relevant");
    },
  );

  // Resolve requested parameter display names -> parameter control descriptors.
  const paramByCaption = new Map(
    parameterColumns.map((c) => [c.caption.trim().toLowerCase(), c]),
  );
  const paramControls: { ref: string; mode: string; displayName: string }[] = (
    filterCfg?.parameters ?? []
  ).map((pName) => {
    const col = paramByCaption.get(pName.trim().toLowerCase());
    if (!col) {
      throw new Error(
        `Dashboard '${spec.name}' filter panel references parameter '${pName}' ` +
          `which does not exist. Create it first (e.g. a Top-N filter's ` +
          `topN.nParameter, or a ParameterSpec) before showing it on the dashboard.`,
      );
    }
    // Control style by domain: list -> dropdown, range -> slider, else type-in.
    const mode =
      col.paramDomainType === "list"
        ? "dropdown"
        : col.paramDomainType === "range"
          ? "slider"
          : "type_in";
    return { ref: `[Parameters].[${col.name}]`, mode, displayName: col.caption };
  });

  const hasFilters = filterFields.length > 0;
  const hasPanel = hasFilters || paramControls.length > 0;
  const filterSource =
    filterCfg?.sourceWorksheet && existing.has(filterCfg.sourceWorksheet)
      ? filterCfg.sourceWorksheet
      : referencedWorksheets[0]!;

  const ids = new ZoneIds();

  // Layout formatting knobs (padding / border / title formatting).
  const innerMargin = spec.innerPadding;
  const outerMargin = spec.outerPadding;
  const border = spec.border;

  // ---- Layout geometry (0-100000 space) ---------------------------------
  const root: Rect = { x: 0, y: 0, w: 100000, h: 100000 };
  const [titleRect, contentRect] = partitionV(root, [6, 94]) as [Rect, Rect];
  const [leftRect, panelRect] = hasPanel
    ? (partitionH(contentRect, [82, 18]) as [Rect, Rect])
    : ([contentRect, contentRect] as [Rect, Rect]);

  // Explicit px `height`/`width` take precedence over relative `*Weight`. On a
  // fixed/range board these read as pixels; partition normalizes by their sum so
  // proportions are exact when they add up to the board dimension.
  const rowWeights = spec.rows.map((r) => r.height ?? r.heightWeight ?? 1);
  const rowRects = partitionV(leftRect, rowWeights);

  // ---- Render chart rows ------------------------------------------------
  const rowXml = spec.rows
    .map((row, ri) => {
      const rowRect = rowRects[ri]!;
      const cellRects = partitionH(
        rowRect,
        row.sheets.map((s) => s.width ?? s.widthWeight ?? 1),
      );
      const cells = row.sheets
        .map((sheet, ci) => {
          const cellRect = cellRects[ci]!;
          const containerId = ids.next();
          const wsId = ids.next();
          const showTitle = sheet.showTitle === false ? " show-title='false'" : "";
          return (
            `            <zone ${dims(cellRect)} id='${containerId}' param='horz' type-v2='layout-flow'>\n` +
            `              <zone ${dims(cellRect)} id='${wsId}' name='${xmlEscape(sheet.worksheet)}'${showTitle}>\n` +
            leafStyle("                ", innerMargin, border) +
            `\n              </zone>\n` +
            containerStyle("              ", spec.containerBackground, innerMargin, border) +
            `\n            </zone>`
          );
        })
        .join("\n");
      const rowId = ids.next();
      return (
        `          <zone ${dims(rowRect)} id='${rowId}' param='horz' type-v2='layout-flow'>\n` +
        cells +
        `\n          </zone>`
      );
    })
    .join("\n");

  const leftId = ids.next();
  const leftXml =
    `        <zone ${dims(leftRect)} id='${leftId}' param='vert' type-v2='layout-flow'>\n` +
    rowXml +
    `\n        </zone>`;

  // ---- Render Filters panel --------------------------------------------
  let panelXml = "";
  if (hasPanel) {
    const panelParts = partitionV(panelRect, [
      1,
      ...filterFields.map(() => 1),
      ...paramControls.map(() => 1),
      2,
    ]);
    const headingRect = panelParts[0]!;
    const emptyRect = panelParts[panelParts.length - 1]!;
    const filterRects = panelParts.slice(1, 1 + filterFields.length);
    const paramRects = panelParts.slice(
      1 + filterFields.length,
      panelParts.length - 1,
    );

    const headingId = ids.next();
    const headingTitle = filterCfg?.panelTitle ?? "Filters";
    const headingRun = runOpen(filterCfg?.panelTitleFormat, {
      bold: true,
      alignment: "center",
      color: "#1b1b1b",
      fontName: "Tableau Semibold",
      fontSize: 12,
    });
    const heading =
      `          <zone fixed-size='42' forceUpdate='true' ${dims(headingRect)} id='${headingId}' is-fixed='true' type-v2='text'>\n` +
      `            <formatted-text>\n` +
      `              ${headingRun}${xmlEscape(headingTitle)}</run>\n` +
      `            </formatted-text>\n` +
      leafStyle("            ", innerMargin, border) +
      `\n          </zone>`;

    const mode = filterCfg?.mode ?? "checkdropdown";
    const showApply = (filterCfg?.showApply ?? true) ? " show-apply='true'" : "";
    const filterZones = filterFields
      .map((ff, i) => {
        const fr = filterRects[i]!;
        const zid = ids.next();
        return (
          `          <zone ${dims(fr)} id='${zid}' mode='${mode}' name='${xmlEscape(filterSource)}' param='${ff.ref}'${showApply} type-v2='filter' values='${ff.values}'>\n` +
          leafStyle("            ", innerMargin, border) +
          `\n          </zone>`
        );
      })
      .join("\n");

    // Parameter controls (Top-N etc.), modeled on the sample's `paramctrl` zone.
    const paramZones = paramControls
      .map((pc, i) => {
        const pr = paramRects[i]!;
        const zid = ids.next();
        return (
          `          <zone ${dims(pr)} id='${zid}' mode='${pc.mode}' param='${pc.ref}' type-v2='paramctrl'>\n` +
          leafStyle("            ", innerMargin, border) +
          `\n          </zone>`
        );
      })
      .join("\n");

    const emptyId = ids.next();
    const emptyZone =
      `          <zone ${dims(emptyRect)} id='${emptyId}' type-v2='empty'>\n` +
      leafStyle("            ", innerMargin, border) +
      `\n          </zone>`;

    const panelId = ids.next();
    // Assemble the panel body, skipping any empty section so we never emit blank
    // lines (filters-only, params-only, and mixed panels are all supported).
    const bodyZones = [heading, filterZones, paramZones, emptyZone].filter(
      (z) => z.length > 0,
    );
    panelXml =
      `        <zone fixed-size='200' ${dims(panelRect)} id='${panelId}' is-fixed='true' param='vert' type-v2='layout-flow'>\n` +
      bodyZones.join("\n") +
      `\n` +
      containerStyle("          ", spec.containerBackground, innerMargin, border) +
      `\n        </zone>`;
  }

  const contentId = ids.next();
  const contentXml =
    `      <zone ${dims(contentRect)} id='${contentId}' param='horz' type-v2='layout-flow'>\n` +
    leftXml +
    (panelXml ? `\n${panelXml}` : "") +
    `\n      </zone>`;

  // ---- Title band -------------------------------------------------------
  const titleText = spec.title ?? spec.name;
  const titleBandId = ids.next();
  const titleTextId = ids.next();
  const titleRun = runOpen(spec.titleFormat, {
    bold: true,
    alignment: "center",
    color: "#1b1b1b",
    fontName: "Tableau Bold",
    fontSize: 16,
  });
  const titleZoneStyle = spec.titleFormat?.backgroundColor
    ? containerStyle(
        "          ",
        spec.titleFormat.backgroundColor,
        innerMargin,
        border,
      )
    : leafStyle("          ", innerMargin, border);
  const titleBand =
    `      <zone fixed-size='50' ${dims(titleRect)} id='${titleBandId}' is-fixed='true' layout-strategy-id='distribute-evenly' param='vert' type-v2='layout-flow'>\n` +
    `        <zone ${dims(titleRect)} id='${titleTextId}' type-v2='text'>\n` +
    `          <formatted-text>\n` +
    `            ${titleRun}${xmlEscape(titleText)}</run>\n` +
    `          </formatted-text>\n` +
    titleZoneStyle +
    `\n        </zone>\n` +
    `      </zone>`;

  const outerId = ids.next();
  const outer =
    `    <zone ${dims(root)} id='${outerId}' param='vert' type-v2='layout-flow'>\n` +
    titleBand +
    `\n` +
    contentXml +
    `\n    </zone>`;

  const rootId = ids.next();
  const zonesXml =
    `      <zones>\n` +
    `        <zone h='100000' id='${rootId}' type-v2='layout-basic' w='100000' x='0' y='0'>\n` +
    outer.replace(/^/gm, "  ") +
    `\n          <zone-style>\n` +
    borderLines("            ", border) +
    `\n            <format attr='margin' value='${outerMargin}' />\n` +
    `          </zone-style>\n` +
    `        </zone>\n` +
    `      </zones>`;

  // ---- Dashboard element parts -----------------------------------------
  const styleXml =
    `      <style>\n` +
    `        <style-rule element='table'>\n` +
    `          <format attr='background-color' value='${xmlEscape(spec.backgroundColor)}' />\n` +
    `        </style-rule>\n` +
    `      </style>`;

  const sizeXml = buildSizeXml(spec);

  const dsXml =
    `      <datasources>\n` +
    `        <datasource caption='${xmlEscape(lock.datasourceName)}' name='${dsId}' />\n` +
    `      </datasources>`;

  let depsXml = "";
  if (hasFilters) {
    const cols = new Map<string, string>();
    const insts = new Map<string, string>();
    for (const ff of filterFields) {
      cols.set(ff.columnDecl, ff.columnDecl);
      insts.set(ff.instanceName, ff.columnInstanceDecl);
    }
    const lines = [...cols.values(), ...insts.values()]
      .map((d) => `        ${d}`)
      .join("\n");
    depsXml =
      `      <datasource-dependencies datasource='${dsId}'>\n` +
      lines +
      `\n      </datasource-dependencies>`;
  }

  // NOTE: do NOT emit `enable-sort-zone-taborder` - some Tableau versions reject
  // it at load time ("attribute 'enable-sort-zone-taborder' is not declared for
  // element 'dashboard'"). A plain `<dashboard name=...>` is universally accepted.
  const dashboardXml =
    `    <dashboard name='${xmlEscape(spec.name)}'>\n` +
    styleXml +
    `\n` +
    sizeXml +
    `\n` +
    dsXml +
    (depsXml ? `\n${depsXml}` : "") +
    `\n` +
    zonesXml +
    `\n      <simple-id uuid='{${randomUUID().toUpperCase()}}' />\n` +
    `    </dashboard>`;

  // ---- Window with a viewpoint per referenced worksheet ----------------
  const viewpoints = referencedWorksheets
    .map(
      (n) =>
        `        <viewpoint name='${xmlEscape(n)}'>\n` +
        `          <zoom type='entire-view' />\n` +
        `        </viewpoint>`,
    )
    .join("\n");
  const windowXml =
    `    <window class='dashboard' name='${xmlEscape(spec.name)}'>\n` +
    `      <viewpoints>\n` +
    viewpoints +
    `\n      </viewpoints>\n` +
    `      <active id='-1' />\n` +
    `      <simple-id uuid='{${randomUUID().toUpperCase()}}' />\n` +
    `    </window>`;

  return {
    name: spec.name,
    dashboardXml,
    windowXml,
    filterFields,
    referencedWorksheets,
  };
}
