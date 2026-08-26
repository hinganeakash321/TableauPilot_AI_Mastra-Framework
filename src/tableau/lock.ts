/**
 * Datasource lock helpers (spec sections 33-35, 87).
 *
 * The uploaded workbook's datasource is the single source of truth. If exactly
 * one datasource exists it is locked automatically; otherwise a selection is
 * required. Once locked, all worksheet operations must reference it.
 */

import type { DatasourceInfo, DatasourceLock } from "../mastra/schemas/datasource.js";
import type { WorkbookInspectionResult } from "../mastra/schemas/workbook.js";
import type { StructuredError } from "../mastra/schemas/common.js";

export type LockOutcome =
  | { ok: true; lock: DatasourceLock }
  | { ok: false; error: StructuredError; datasources: DatasourceInfo[] };

/** Builds a lock from a chosen datasource. */
export function lockFromDatasource(
  ds: DatasourceInfo,
  workbookPath: string,
): DatasourceLock {
  return {
    workbookPath,
    datasourceName: ds.caption ?? ds.name,
    datasourceId: ds.id,
    connectionType: ds.connectionType,
    connectionMode: ds.connectionMode,
    locked: true,
  };
}

/**
 * Determines the datasource lock for a workbook. Auto-locks when there is a
 * single datasource; requires `selectedDatasourceId` when there are several
 * (spec section 33). Never creates a datasource (spec section 30).
 */
export function resolveLock(
  inspection: WorkbookInspectionResult,
  workbookPath: string,
  selectedDatasourceId?: string,
): LockOutcome {
  const datasources = inspection.datasources;
  if (datasources.length === 0) {
    return {
      ok: false,
      error: {
        code: "DATASOURCE_NOT_FOUND",
        message: "The workbook contains no datasource to lock.",
      },
      datasources,
    };
  }

  if (selectedDatasourceId) {
    const chosen = datasources.find((d) => d.id === selectedDatasourceId);
    if (!chosen) {
      return {
        ok: false,
        error: {
          code: "DATASOURCE_NOT_FOUND",
          message: `Datasource '${selectedDatasourceId}' not found in workbook.`,
          details: { available: datasources.map((d) => d.id) },
        },
        datasources,
      };
    }
    return { ok: true, lock: lockFromDatasource(chosen, workbookPath) };
  }

  if (datasources.length === 1) {
    return { ok: true, lock: lockFromDatasource(datasources[0]!, workbookPath) };
  }

  return {
    ok: false,
    error: {
      code: "MULTIPLE_DATASOURCES",
      message:
        "Multiple datasources found. Select one to lock (a new datasource is " +
        "never created).",
      details: {
        datasources: datasources.map((d) => ({ id: d.id, name: d.name })),
      },
    },
    datasources,
  };
}
