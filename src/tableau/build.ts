/**
 * High-level build pipeline (spec sections 60-62, 75, 81).
 *
 * Orchestrates: open TWBX -> apply worksheet specs to the TWB -> write a working
 * TWBX -> validate -> package a final TWBX. The datasource block and all `Data/`
 * resources (incl. `.hyper`) are preserved throughout.
 */

import { basename, join } from "node:path";
import { openTwbx, writeTwbx, ensureWorkspace, type OpenedTwbx } from "./twbx.js";
import { inspectTwbXml } from "./twb.js";
import {
  applyDashboards,
  applyWorksheets,
  existingWorksheetNames,
} from "./compiler/workbookCompiler.js";
import {
  validateGeneratedTwb,
  validateTwbxStructure,
} from "./validators/index.js";
import type {
  CalculatedFieldSpec,
  ParameterSpec,
  WorksheetSpec,
} from "../mastra/schemas/worksheet.js";
import type { DashboardSpec } from "../mastra/schemas/dashboard.js";
import type { FieldInfo } from "../mastra/schemas/workbook.js";
import type { DatasourceLock } from "../mastra/schemas/datasource.js";
import type {
  ValidationResult,
  StructuredError,
} from "../mastra/schemas/common.js";
import type { WorkbookBuildResult } from "../mastra/schemas/worksheet.js";

export interface CompileToWorkingResult {
  workingPath: string;
  twbEntryName: string;
  added: string[];
  modified: string[];
  dashboardsAdded: string[];
  dashboardsModified: string[];
  calculationsAdded: { caption: string; name: string }[];
  parametersAdded: { caption: string; name: string }[];
  /** Original fields plus any newly-created calc fields (for validation). */
  effectiveFields: FieldInfo[];
  errors: StructuredError[];
  beforeWorksheets: number;
  afterWorksheets: number;
}

/** Applies specs to a source TWBX and writes a working TWBX. */
export async function compileWorkbookToWorking(opts: {
  sourceTwbxPath: string;
  specs: WorksheetSpec[];
  lock: DatasourceLock;
  fields: FieldInfo[];
  calculations?: CalculatedFieldSpec[];
  parameters?: ParameterSpec[];
  dashboards?: DashboardSpec[];
  collision?: "modify_existing" | "create_new_version" | "error";
  workspaceRoot?: string;
}): Promise<CompileToWorkingResult> {
  const ws = await ensureWorkspace(opts.workspaceRoot ?? "./workspace");
  const opened = await openTwbx(opts.sourceTwbxPath);
  const before = existingWorksheetNames(opened.twbXml).length;

  const applied = applyWorksheets(
    opened.twbXml,
    opts.specs,
    opts.lock,
    opts.fields,
    {
      onCollision: opts.collision ?? "modify_existing",
      calculations: opts.calculations,
      parameters: opts.parameters,
    },
  );

  // Dashboards are applied AFTER worksheets so they can reference newly-built
  // sheets, and their apply-to-all filters land on every datasource worksheet.
  let finalTwbXml = applied.twbXml;
  const dashboardsAdded: string[] = [];
  const dashboardsModified: string[] = [];
  const errors = [...applied.errors];
  if (opts.dashboards && opts.dashboards.length > 0) {
    const dash = applyDashboards(
      finalTwbXml,
      opts.dashboards,
      opts.lock,
      applied.effectiveFields,
    );
    finalTwbXml = dash.twbXml;
    dashboardsAdded.push(...dash.dashboardsAdded);
    dashboardsModified.push(...dash.dashboardsModified);
    errors.push(...dash.errors);
  }

  const base = basename(opts.sourceTwbxPath).replace(/\.twbx?$/i, "");
  const workingPath = join(ws.working, `${base}_working.twbx`);
  await writeTwbx(
    workingPath,
    opened.twbEntryName,
    finalTwbXml,
    opened.entries,
  );
  const after = existingWorksheetNames(finalTwbXml).length;

  return {
    workingPath,
    twbEntryName: opened.twbEntryName,
    added: applied.added,
    modified: applied.modified,
    dashboardsAdded,
    dashboardsModified,
    calculationsAdded: applied.calculationsAdded,
    parametersAdded: applied.parametersAdded,
    effectiveFields: applied.effectiveFields,
    errors,
    beforeWorksheets: before,
    afterWorksheets: after,
  };
}

/** Validates a TWBX file (structure + TWB + generated worksheets). */
export async function validateTwbxFile(opts: {
  twbxPath: string;
  lock: DatasourceLock;
  fields: FieldInfo[];
  targetWorksheets?: string[];
}): Promise<{ result: ValidationResult; opened: OpenedTwbx }> {
  const opened = await openTwbx(opts.twbxPath);
  const structure = validateTwbxStructure(opened);
  const twb = validateGeneratedTwb(
    opened.twbXml,
    opts.lock,
    opts.fields,
    opts.targetWorksheets,
  );
  const errors = [...structure.errors, ...twb.errors];
  const warnings = [...structure.warnings, ...twb.warnings];
  return {
    result: { valid: errors.length === 0, errors, warnings },
    opened,
  };
}

/** Packages a working TWBX into the output directory. */
export async function packageTwbx(opts: {
  workingTwbxPath: string;
  outputName: string;
  workspaceRoot?: string;
}): Promise<{ outputPath: string }> {
  const ws = await ensureWorkspace(opts.workspaceRoot ?? "./workspace");
  const opened = await openTwbx(opts.workingTwbxPath);
  const name = opts.outputName.endsWith(".twbx")
    ? opts.outputName
    : `${opts.outputName}.twbx`;
  const outputPath = join(ws.output, name);
  await writeTwbx(outputPath, opened.twbEntryName, opened.twbXml, opened.entries);
  return { outputPath };
}

/**
 * End-to-end build: compile -> validate -> package. Returns a
 * {@link WorkbookBuildResult}. Never reports success unless validation passes.
 */
export async function buildWorkbook(opts: {
  sourceTwbxPath: string;
  specs: WorksheetSpec[];
  lock: DatasourceLock;
  fields: FieldInfo[];
  calculations?: CalculatedFieldSpec[];
  parameters?: ParameterSpec[];
  dashboards?: DashboardSpec[];
  collision?: "modify_existing" | "create_new_version" | "error";
  outputName?: string;
  workspaceRoot?: string;
}): Promise<WorkbookBuildResult> {
  const steps: string[] = [];
  const compiled = await compileWorkbookToWorking(opts);
  steps.push("Worksheet compiler executed");
  if (compiled.dashboardsAdded.length || compiled.dashboardsModified.length) {
    steps.push("Dashboard compiler executed");
  }
  if (compiled.errors.length > 0) {
    return {
      success: false,
      worksheetsAdded: compiled.added,
      worksheetsModified: compiled.modified,
      dashboardsAdded: compiled.dashboardsAdded,
      dashboardsModified: compiled.dashboardsModified,
      datasourcePreserved: true,
      validationPassed: false,
      steps,
    };
  }

  const target = [...compiled.added, ...compiled.modified];
  const validation = await validateTwbxFile({
    twbxPath: compiled.workingPath,
    lock: opts.lock,
    // Validate against the augmented field set so references to newly-created
    // calculated fields resolve.
    fields: compiled.effectiveFields,
    targetWorksheets: target,
  });
  steps.push("TWB validated");
  steps.push("TWBX structure validated");
  if (!validation.result.valid) {
    return {
      success: false,
      worksheetsAdded: compiled.added,
      worksheetsModified: compiled.modified,
      dashboardsAdded: compiled.dashboardsAdded,
      dashboardsModified: compiled.dashboardsModified,
      datasourcePreserved: true,
      validationPassed: false,
      steps,
    };
  }

  const outputName =
    opts.outputName ??
    `${basename(opts.sourceTwbxPath).replace(/\.twbx?$/i, "")}_generated`;
  const packaged = await packageTwbx({
    workingTwbxPath: compiled.workingPath,
    outputName,
    workspaceRoot: opts.workspaceRoot,
  });
  steps.push("TWBX packaged");

  // Confirm the datasource id survived packaging.
  const finalInfo = inspectTwbXml(validation.opened.twbXml, outputName);
  const datasourcePreserved =
    finalInfo.datasources[0]?.id === opts.lock.datasourceId;

  return {
    success: true,
    outputPath: packaged.outputPath,
    worksheetsAdded: compiled.added,
    worksheetsModified: compiled.modified,
    dashboardsAdded: compiled.dashboardsAdded,
    dashboardsModified: compiled.dashboardsModified,
    datasourcePreserved,
    validationPassed: true,
    diff: {
      before: { worksheets: compiled.beforeWorksheets },
      after: { worksheets: compiled.afterWorksheets },
      added: compiled.added,
      modified: compiled.modified,
      deleted: [],
    },
    steps,
  };
}
