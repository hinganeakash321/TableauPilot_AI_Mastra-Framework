/**
 * Dashboard tools.
 *
 * Compile one or more dashboard specs into a WORKING TWBX (the original is never
 * modified), applying apply-to-all context filters across every worksheet that
 * uses the locked datasource. Dashboards are validated as part of the working
 * TWBX. Consistent with the current single-approval, no-packaging flow, these
 * tools do not require a separate approval step - the validated working TWBX is
 * the deliverable, captured for download/deploy by the web layer.
 */

import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import {
  compileWorkbookToWorking,
  validateTwbxFile,
} from "../../tableau/build.js";
import {
  DashboardSpecSchema,
  WorksheetSpecSchema,
  DatasourceLockSchema,
  ValidationResultSchema,
} from "../schemas/index.js";
import { runTool, toolResult } from "./_shared.js";

const CollisionSchema = z
  .enum(["modify_existing", "create_new_version", "error"])
  .default("modify_existing");

const dashboardResult = z.object({
  workingPath: z.string(),
  dashboardsAdded: z.array(z.string()),
  dashboardsModified: z.array(z.string()),
  worksheetsAdded: z.array(z.string()),
  worksheetsModified: z.array(z.string()),
  validation: ValidationResultSchema,
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
});

/** Shared implementation for create/modify. */
async function buildWithDashboards(input: {
  sourceTwbxPath: string;
  lock: z.infer<typeof DatasourceLockSchema>;
  dashboards: z.infer<typeof DashboardSpecSchema>[];
  specs?: z.infer<typeof WorksheetSpecSchema>[];
  collision: "modify_existing" | "create_new_version" | "error";
}) {
  const r = await inspectWorkbookFile(input.sourceTwbxPath);
  const res = await compileWorkbookToWorking({
    sourceTwbxPath: input.sourceTwbxPath,
    specs: input.specs ?? [],
    dashboards: input.dashboards,
    lock: input.lock,
    fields: r.fields,
    collision: input.collision,
  });

  // Validate the working TWBX (structure + TWB + newly-built worksheets).
  const target = [...res.added, ...res.modified];
  const { result: validation } = await validateTwbxFile({
    twbxPath: res.workingPath,
    lock: input.lock,
    fields: res.effectiveFields,
    targetWorksheets: target,
  });

  return {
    workingPath: res.workingPath,
    dashboardsAdded: res.dashboardsAdded,
    dashboardsModified: res.dashboardsModified,
    worksheetsAdded: res.added,
    worksheetsModified: res.modified,
    validation,
    errors: res.errors.map((e) => ({ code: e.code, message: e.message })),
  };
}

export const createDashboard = createTool({
  id: "createDashboard",
  description:
    "Build one or more Tableau dashboards into a WORKING TWBX from the given " +
    "source (usually the working TWBX that already contains the target " +
    "worksheets). Each dashboard gets a title band, a chart grid (rows of " +
    "worksheets), an optional right-side Filters panel (multi-select dropdown + " +
    "Apply button + relevant values), container/background formatting, and " +
    "automatic or fixed sizing. Filters are applied to ALL worksheets using the " +
    "locked datasource (default select-all). Optionally also build new worksheets " +
    "first via `specs`. Returns the working path + validation.",
  inputSchema: z.object({
    sourceTwbxPath: z.string(),
    lock: DatasourceLockSchema,
    dashboards: z.array(DashboardSpecSchema).min(1),
    /** Optional new worksheets to build before the dashboards reference them. */
    specs: z.array(WorksheetSpecSchema).optional(),
    collision: CollisionSchema,
  }),
  outputSchema: toolResult(dashboardResult),
  execute: async (inputData) =>
    runTool(
      () =>
        buildWithDashboards({
          sourceTwbxPath: inputData.sourceTwbxPath,
          lock: inputData.lock,
          dashboards: inputData.dashboards,
          specs: inputData.specs,
          collision: inputData.collision,
        }),
      "VALIDATION_FAILED",
    ),
});

export const modifyDashboard = createTool({
  id: "modifyDashboard",
  description:
    "Modify an existing dashboard by replacing it with a full updated spec (e.g. " +
    "to add/remove worksheets, change sizing, or adjust filters). Supply the " +
    "COMPLETE desired dashboard (same `name`); it replaces the current one. " +
    "Operates on a source TWBX and writes a new working TWBX.",
  inputSchema: z.object({
    sourceTwbxPath: z.string(),
    lock: DatasourceLockSchema,
    dashboard: DashboardSpecSchema,
    /** Optional new worksheets to build before the dashboard references them. */
    specs: z.array(WorksheetSpecSchema).optional(),
  }),
  outputSchema: toolResult(dashboardResult),
  execute: async (inputData) =>
    runTool(
      () =>
        buildWithDashboards({
          sourceTwbxPath: inputData.sourceTwbxPath,
          lock: inputData.lock,
          dashboards: [inputData.dashboard],
          specs: inputData.specs,
          collision: "modify_existing",
        }),
      "VALIDATION_FAILED",
    ),
});

export const dashboardTools = {
  createDashboard,
  modifyDashboard,
};
