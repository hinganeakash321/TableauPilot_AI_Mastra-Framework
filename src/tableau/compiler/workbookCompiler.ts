/**
 * Workbook-level compiler: applies a set of worksheet specs to a TWB XML string
 * by inserting `<worksheet>` blocks into `<worksheets>` and matching
 * `<window class='worksheet'>` entries into `<windows>`.
 *
 * Modifications are targeted string operations - the locked datasource block is
 * never touched (spec sections 35, 36, 39). The lock is validated first.
 */

import type {
  CalculatedFieldSpec,
  ParameterSpec,
  WorksheetSpec,
} from "../../mastra/schemas/worksheet.js";
import type { DashboardSpec } from "../../mastra/schemas/dashboard.js";
import type { FieldInfo } from "../../mastra/schemas/workbook.js";
import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type { StructuredError } from "../../mastra/schemas/common.js";
import { compileWorksheet } from "./worksheetCompiler.js";
import {
  compileDashboard,
  type ResolvedFilterField,
} from "./dashboardCompiler.js";
import { injectApplyToAllFilters } from "./dashboardFilters.js";
import { addCalculatedFields } from "./calculatedFields.js";
import {
  addParameters,
  parseExistingParameterColumns,
  type ParameterColumn,
} from "./parameters.js";
import { ensureSection, insertBeforeLast, xmlEscape } from "../xml.js";
import { randomUUID } from "node:crypto";
import type { DashboardActionSpec } from "../../mastra/schemas/dashboard.js";

/** Options controlling collision behavior for a single apply. */
export interface ApplyOptions {
  /** When a worksheet name already exists: replace it or add a versioned copy. */
  onCollision: "modify_existing" | "create_new_version" | "error";
  /**
   * Calculated fields to create in the locked datasource before compiling the
   * worksheets (in addition to any declared on individual worksheet specs).
   */
  calculations?: CalculatedFieldSpec[];
  /**
   * Parameters to create in the Parameters datasource before compiling the
   * worksheets (in addition to any declared on individual worksheet specs).
   */
  parameters?: ParameterSpec[];
}

/** Result of applying worksheets to a workbook. */
export interface ApplyResult {
  twbXml: string;
  added: string[];
  modified: string[];
  /** Calculated fields created in the datasource (caption -> synthetic name). */
  calculationsAdded: { caption: string; name: string }[];
  /** Parameters created (caption -> internal `Parameter N` name). */
  parametersAdded: { caption: string; name: string }[];
  /** Original fields plus any newly-created calc fields (for validation). */
  effectiveFields: FieldInfo[];
  errors: StructuredError[];
}

/** Escapes a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the id of the workbook's real (data) datasource. Tableau writes a
 * special `<datasource name='Parameters'>` pseudo-datasource that can appear
 * first; it is skipped so we always resolve the actual locked datasource.
 */
export function getWorkbookDatasourceId(twbXml: string): string | undefined {
  const worksheetsIdx = twbXml.indexOf("<worksheets>");
  const head = worksheetsIdx === -1 ? twbXml : twbXml.slice(0, worksheetsIdx);
  const dsIdx = head.indexOf("<datasources>");
  if (dsIdx === -1) return undefined;
  const re = /<datasource\b[^>]*\bname='([^']*)'/g;
  let m: RegExpExecArray | null;
  let first: string | undefined;
  const scope = head.slice(dsIdx);
  while ((m = re.exec(scope)) !== null) {
    const name = m[1]!;
    if (first === undefined) first = name;
    if (name !== "Parameters") return name;
  }
  return first;
}

/** Lists existing worksheet names in a TWB. */
export function existingWorksheetNames(twbXml: string): string[] {
  const names: string[] = [];
  const re = /<worksheet name='([^']*)'>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(twbXml)) !== null) names.push(m[1]!);
  return names;
}

/** Removes a worksheet and its window entry by name. */
function removeWorksheet(twbXml: string, name: string): string {
  const n = escapeRegExp(name);
  let out = twbXml.replace(
    new RegExp(`\\s*<worksheet name='${n}'>[\\s\\S]*?<\\/worksheet>`),
    "",
  );
  out = out.replace(
    new RegExp(
      `\\s*<window class='worksheet' name='${n}'>[\\s\\S]*?<\\/window>`,
    ),
    "",
  );
  return out;
}

/** Ensures `<worksheets>` and `<windows>` sections exist. */
function ensureSections(twbXml: string): string {
  let out = ensureSection(twbXml, "<worksheets>", "</worksheets>", "</workbook>");
  out = ensureSection(out, "<windows>", "</windows>", "</workbook>");
  return out;
}

/**
 * Validates that the lock matches the workbook's datasource. Returns an error if
 * there is a mismatch (spec section 35 - DATASOURCE_LOCK_VIOLATION).
 */
export function validateLockAgainstWorkbook(
  twbXml: string,
  lock: DatasourceLock,
): StructuredError | null {
  const wbDsId = getWorkbookDatasourceId(twbXml);
  if (!wbDsId) {
    return {
      code: "DATASOURCE_NOT_FOUND",
      message: "No datasource found in the workbook.",
    };
  }
  if (wbDsId !== lock.datasourceId) {
    return {
      code: "DATASOURCE_LOCK_VIOLATION",
      message:
        `Locked datasource '${lock.datasourceId}' does not match workbook ` +
        `datasource '${wbDsId}'. Refusing to modify the workbook.`,
      details: { locked: lock.datasourceId, workbook: wbDsId },
    };
  }
  return null;
}

/**
 * Applies worksheet specs to a TWB XML string. Enforces the datasource lock and
 * inserts worksheet + window blocks.
 */
export function applyWorksheets(
  twbXml: string,
  specs: WorksheetSpec[],
  lock: DatasourceLock,
  fields: FieldInfo[],
  options: ApplyOptions = { onCollision: "modify_existing" },
): ApplyResult {
  const errors: StructuredError[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const calculationsAdded: { caption: string; name: string }[] = [];
  const parametersAdded: { caption: string; name: string }[] = [];

  const lockError = validateLockAgainstWorkbook(twbXml, lock);
  if (lockError) {
    return {
      twbXml,
      added,
      modified,
      calculationsAdded,
      parametersAdded,
      effectiveFields: fields,
      errors: [lockError],
    };
  }

  let out = ensureSections(twbXml);

  // Create calculated fields (from options + per-worksheet specs) in the locked
  // datasource FIRST, then compile worksheets against the augmented field set so
  // references to the new fields resolve to their synthetic column names.
  let effectiveFields = fields;
  const allCalcs: CalculatedFieldSpec[] = [
    ...(options.calculations ?? []),
    ...specs.flatMap((s) => s.calculations ?? []),
  ];
  // De-duplicate calc specs by name (case-insensitive), keeping the first.
  const seenCalc = new Set<string>();
  const dedupedCalcs = allCalcs.filter((c) => {
    const key = c.name.trim().toLowerCase();
    if (!key || seenCalc.has(key)) return false;
    seenCalc.add(key);
    return true;
  });
  if (dedupedCalcs.length) {
    const calcResult = addCalculatedFields(out, lock, dedupedCalcs, fields);
    out = calcResult.twbXml;
    effectiveFields = [...fields, ...calcResult.newFields];
    calculationsAdded.push(...calcResult.created);
    for (const e of calcResult.errors) {
      errors.push({ code: "VALIDATION_FAILED", message: e });
    }
  }

  // Create parameters (from options + per-worksheet specs) in the Parameters
  // datasource, then expose every parameter column (existing + new) so Top-N
  // filters can reference `[Parameters].[Parameter N]`.
  const allParams: ParameterSpec[] = [
    ...(options.parameters ?? []),
    ...specs.flatMap((s) => s.parameters ?? []),
  ];
  const seenParam = new Set<string>();
  const dedupedParams = allParams.filter((p) => {
    const key = p.name.trim().toLowerCase();
    if (!key || seenParam.has(key)) return false;
    seenParam.add(key);
    return true;
  });
  let paramColumns: ParameterColumn[] = [];
  {
    const paramResult = addParameters(out, dedupedParams);
    out = paramResult.twbXml;
    paramColumns = paramResult.columns;
    parametersAdded.push(...paramResult.created);
    for (const e of paramResult.errors) {
      errors.push({ code: "VALIDATION_FAILED", message: e });
    }
  }

  for (const spec of specs) {
    const existing = new Set(existingWorksheetNames(out));
    let targetSpec = spec;
    let isModify = false;

    if (existing.has(spec.name)) {
      if (options.onCollision === "error") {
        errors.push({
          code: "WORKSHEET_COLLISION",
          message: `Worksheet '${spec.name}' already exists.`,
          suggestions: ["modify_existing", "create_new_version"],
        });
        continue;
      }
      if (options.onCollision === "create_new_version") {
        let i = 2;
        let candidate = `${spec.name} (${i})`;
        while (existing.has(candidate)) {
          i += 1;
          candidate = `${spec.name} (${i})`;
        }
        targetSpec = { ...spec, name: candidate };
      } else {
        out = removeWorksheet(out, spec.name);
        isModify = true;
      }
    }

    let compiled;
    try {
      compiled = compileWorksheet(targetSpec, lock, effectiveFields, paramColumns);
    } catch (err) {
      errors.push({
        code: "VALIDATION_FAILED",
        message: `Failed to compile worksheet '${targetSpec.name}': ${
          (err as Error).message
        }`,
      });
      continue;
    }

    out = insertBeforeLast(out, "</worksheets>", `\n${compiled.worksheetXml}\n  `);
    out = insertBeforeLast(out, "</windows>", `\n${compiled.windowXml}\n  `);

    if (isModify) modified.push(targetSpec.name);
    else added.push(targetSpec.name);
  }

  return {
    twbXml: out,
    added,
    modified,
    calculationsAdded,
    parametersAdded,
    effectiveFields,
    errors,
  };
}

/** Lists existing dashboard names in a TWB. */
export function existingDashboardNames(twbXml: string): string[] {
  const names: string[] = [];
  const re = /<dashboard\b[^>]*\bname='([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(twbXml)) !== null) names.push(m[1]!);
  return names;
}

/** Ensures a `<dashboards>` section exists, placed right after `</worksheets>`. */
function ensureDashboardsSection(twbXml: string): string {
  if (twbXml.includes("</dashboards>")) return twbXml;
  if (twbXml.includes("</worksheets>")) {
    return twbXml.replace(
      "</worksheets>",
      "</worksheets>\n  <dashboards>\n  </dashboards>",
    );
  }
  // No worksheets section - fall back to inserting before </workbook>.
  return ensureSection(twbXml, "<dashboards>", "</dashboards>", "</workbook>");
}

/** Removes a dashboard block and its `<window class='dashboard'>` entry. */
function removeDashboard(twbXml: string, name: string): string {
  const n = escapeRegExp(name);
  let out = twbXml.replace(
    new RegExp(`\\s*<dashboard\\b[^>]*\\bname='${n}'>[\\s\\S]*?<\\/dashboard>`),
    "",
  );
  out = out.replace(
    new RegExp(
      `\\s*<window class='dashboard' name='${n}'>[\\s\\S]*?<\\/window>`,
    ),
    "",
  );
  return out;
}

/** Ensures a workbook-level `<actions>` section exists (before `<worksheets>`). */
function ensureActionsSection(twbXml: string): string {
  if (twbXml.includes("</actions>")) return twbXml;
  if (twbXml.includes("<worksheets>")) {
    return twbXml.replace("<worksheets>", "<actions>\n  </actions>\n  <worksheets>");
  }
  return ensureSection(twbXml, "<actions>", "</actions>", "</workbook>");
}

/** Removes any `<action>` whose filter command targets the given dashboard. */
function removeActionsForDashboard(twbXml: string, dashName: string): string {
  const n = escapeRegExp(dashName);
  return twbXml.replace(
    new RegExp(
      `\\s*<action\\b[^>]*>[\\s\\S]*?<param name='target' value='${n}' />[\\s\\S]*?<\\/action>`,
      "g",
    ),
    "",
  );
}

/**
 * Builds a dashboard FILTER action ("use as filter"), modeled on the sample
 * workbook. Selecting a mark on a source sheet filters the other sheets on the
 * dashboard. KPI/scorecard sheets are excluded by default so clicking a big
 * number does not filter everything.
 */
function buildFilterAction(
  dashName: string,
  referencedWorksheets: string[],
  action: DashboardActionSpec,
  index: number,
): string {
  const caption = action.caption ?? `Filter on ${dashName}`;
  const hex = randomUUID().replace(/-/g, "").toUpperCase();
  const name = `Action${index}_${hex}`;
  const activation =
    action.runOn === "hover"
      ? `<activation auto-clear='true' type='on-hover' />`
      : action.runOn === "menu"
        ? `<activation type='on-menu' />`
        : `<activation auto-clear='true' type='on-select' />`;
  const explicit = new Set(action.excludeSheets ?? []);
  const excluded = referencedWorksheets.filter(
    (w) => explicit.has(w) || /kpi/i.test(w),
  );
  const excludeXml = excluded
    .map((w) => `        <exclude-sheet name='${xmlEscape(w)}' />`)
    .join("\n");
  return (
    `    <action caption='${xmlEscape(caption)}' name='[${name}]'>\n` +
    `      ${activation}\n` +
    `      <source dashboard='${xmlEscape(dashName)}' type='sheet'>\n` +
    (excludeXml ? excludeXml + "\n" : "") +
    `      </source>\n` +
    `      <command command='tsc:tsl-filter'>\n` +
    `        <param name='special-fields' value='all' />\n` +
    `        <param name='target' value='${xmlEscape(dashName)}' />\n` +
    `      </command>\n` +
    `    </action>`
  );
}

/** Result of applying dashboards to a workbook. */
export interface ApplyDashboardsResult {
  twbXml: string;
  dashboardsAdded: string[];
  dashboardsModified: string[];
  /** Number of worksheets that received apply-to-all filters. */
  worksheetsFiltered: number;
  errors: StructuredError[];
}

/**
 * Applies dashboard specs to a TWB: inserts each `<dashboard>` + its window, then
 * injects apply-to-all context filters into every worksheet using the locked
 * datasource. Existing dashboards with the same name are replaced (modify).
 */
export function applyDashboards(
  twbXml: string,
  dashboards: DashboardSpec[],
  lock: DatasourceLock,
  fields: FieldInfo[],
): ApplyDashboardsResult {
  const errors: StructuredError[] = [];
  const dashboardsAdded: string[] = [];
  const dashboardsModified: string[] = [];

  if (dashboards.length === 0) {
    return {
      twbXml,
      dashboardsAdded,
      dashboardsModified,
      worksheetsFiltered: 0,
      errors,
    };
  }

  const lockError = validateLockAgainstWorkbook(twbXml, lock);
  if (lockError) {
    return {
      twbXml,
      dashboardsAdded,
      dashboardsModified,
      worksheetsFiltered: 0,
      errors: [lockError],
    };
  }

  let out = ensureSections(twbXml);
  out = ensureDashboardsSection(out);

  // Parameters already created (by worksheets applied earlier in this build) so a
  // dashboard can show them as controls in its filters panel.
  const parameterColumns = parseExistingParameterColumns(out);

  const allFilterFields: ResolvedFilterField[] = [];

  let actionIndex = 1;
  for (const spec of dashboards) {
    const existing = new Set(existingDashboardNames(out));
    const isModify = existing.has(spec.name);
    if (isModify) out = removeDashboard(out, spec.name);
    // Always clear any prior actions for this dashboard so modify doesn't orphan
    // or duplicate them.
    out = removeActionsForDashboard(out, spec.name);

    let compiled;
    try {
      compiled = compileDashboard(
        spec,
        lock,
        fields,
        existingWorksheetNames(out),
        parameterColumns,
      );
    } catch (err) {
      errors.push({
        code: "VALIDATION_FAILED",
        message: `Failed to compile dashboard '${spec.name}': ${
          (err as Error).message
        }`,
      });
      continue;
    }

    out = ensureDashboardsSection(out);
    out = insertBeforeLast(out, "</dashboards>", `\n${compiled.dashboardXml}\n  `);
    out = insertBeforeLast(out, "</windows>", `\n${compiled.windowXml}\n  `);

    // Dashboard actions (e.g. use-as-filter), inserted at workbook level.
    const actions = spec.actions ?? [];
    if (actions.length > 0) {
      out = ensureActionsSection(out);
      for (const action of actions) {
        const actionXml = buildFilterAction(
          spec.name,
          compiled.referencedWorksheets,
          action,
          actionIndex,
        );
        actionIndex += 1;
        out = insertBeforeLast(out, "</actions>", `\n${actionXml}\n  `);
      }
    }

    if (spec.filters?.applyToAllWorksheets ?? true) {
      allFilterFields.push(...compiled.filterFields);
    }

    if (isModify) dashboardsModified.push(spec.name);
    else dashboardsAdded.push(spec.name);
  }

  // Inject apply-to-all filters across every datasource worksheet (once).
  const injection = injectApplyToAllFilters(out, lock, allFilterFields);
  out = injection.twbXml;

  // Defensive normalization: some Tableau versions reject
  // `enable-sort-zone-taborder` on <dashboard> ("attribute ... is not declared
  // for element 'dashboard'"), which fails the WHOLE workbook load. Our compiler
  // never emits it, but a pass-through dashboard from the uploaded workbook might
  // carry it - strip it from every dashboard so the file always opens.
  out = out.replace(
    /(<dashboard\b[^>]*?)\s+enable-sort-zone-taborder='[^']*'/g,
    "$1",
  );

  return {
    twbXml: out,
    dashboardsAdded,
    dashboardsModified,
    worksheetsFiltered: injection.worksheetsInjected,
    errors,
  };
}
