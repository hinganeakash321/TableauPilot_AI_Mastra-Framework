/**
 * Workbook inspection tools (spec section 19 - WORKBOOK).
 *
 * These are read-only; they extract metadata from a TWBX/TWB. The full XML is
 * never returned to keep model context small (spec section 57).
 */

import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import { listWorkbookFiles, UPLOADS_DIR } from "../../tableau/paths.js";
import {
  WorkbookInspectionResultSchema,
  DatasourceInfoSchema,
  ConnectionInfoSchema,
  FieldInfoSchema,
  WorksheetInfoSchema,
  CalculatedFieldInfoSchema,
  ParameterInfoSchema,
} from "../schemas/index.js";
import { runTool, toolResult } from "./_shared.js";

const PathInput = z.object({
  twbxPath: z
    .string()
    .describe(
      "Path or filename of the .twbx/.twb. A bare filename is resolved from the " +
        "uploads inbox / workspace (users upload files, never paste them).",
    ),
});

export const listWorkbooks = createTool({
  id: "listWorkbooks",
  description:
    "List Tableau workbooks (.twbx/.twb) available in the uploads inbox and " +
    "workspace. Use this to find the file a user uploaded instead of expecting " +
    "them to paste it into the chat. Reference a returned file by its `name`.",
  inputSchema: z.object({}),
  outputSchema: toolResult(
    z.object({
      uploadsDir: z.string(),
      workbooks: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          sizeBytes: z.number(),
          modified: z.string(),
          location: z.string(),
        }),
      ),
    }),
  ),
  execute: async () =>
    runTool(async () => {
      const workbooks = await listWorkbookFiles();
      return { uploadsDir: UPLOADS_DIR, workbooks };
    }, "IO_ERROR"),
});

export const inspectWorkbook = createTool({
  id: "inspectWorkbook",
  description:
    "Inspect a TWBX/TWB and return full workbook metadata: datasources, fields, " +
    "calculated fields, parameters, worksheets, and counts. Read-only.",
  inputSchema: PathInput,
  outputSchema: toolResult(WorkbookInspectionResultSchema),
  execute: async (inputData) =>
    runTool(() => inspectWorkbookFile(inputData.twbxPath), "TWBX_INVALID"),
});

export const inspectDatasources = createTool({
  id: "inspectDatasources",
  description: "List the datasources discovered in the workbook.",
  inputSchema: PathInput,
  outputSchema: toolResult(z.object({ datasources: z.array(DatasourceInfoSchema) })),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      return { datasources: r.datasources };
    }, "TWBX_INVALID"),
});

export const inspectConnections = createTool({
  id: "inspectConnections",
  description: "List connections for each datasource (class, server, filename).",
  inputSchema: PathInput,
  outputSchema: toolResult(
    z.object({
      connections: z.array(
        z.object({
          datasourceId: z.string(),
          connections: z.array(ConnectionInfoSchema),
        }),
      ),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      return {
        connections: r.datasources.map((d) => ({
          datasourceId: d.id,
          connections: d.connections,
        })),
      };
    }, "TWBX_INVALID"),
});

export const inspectFields = createTool({
  id: "inspectFields",
  description:
    "List fields (dimensions/measures) in the workbook, optionally filtered to " +
    "a datasource id.",
  inputSchema: PathInput.extend({
    datasourceId: z.string().optional(),
  }),
  outputSchema: toolResult(z.object({ fields: z.array(FieldInfoSchema) })),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      const fields = inputData.datasourceId
        ? r.fields.filter((f) => f.datasourceId === inputData.datasourceId)
        : r.fields;
      return { fields };
    }, "TWBX_INVALID"),
});

export const inspectWorksheets = createTool({
  id: "inspectWorksheets",
  description: "List existing worksheets in the workbook.",
  inputSchema: PathInput,
  outputSchema: toolResult(z.object({ worksheets: z.array(WorksheetInfoSchema) })),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      return { worksheets: r.worksheets };
    }, "TWBX_INVALID"),
});

export const inspectCalculatedFields = createTool({
  id: "inspectCalculatedFields",
  description: "List calculated fields (name + formula) defined in the workbook.",
  inputSchema: PathInput,
  outputSchema: toolResult(
    z.object({ calculatedFields: z.array(CalculatedFieldInfoSchema) }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      return { calculatedFields: r.calculatedFields };
    }, "TWBX_INVALID"),
});

export const inspectParameters = createTool({
  id: "inspectParameters",
  description: "List parameters defined in the workbook.",
  inputSchema: PathInput,
  outputSchema: toolResult(z.object({ parameters: z.array(ParameterInfoSchema) })),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      return { parameters: r.parameters };
    }, "TWBX_INVALID"),
});

export const inspectExtracts = createTool({
  id: "inspectExtracts",
  description:
    "Report whether each datasource uses an embedded extract (.hyper) or a live " +
    "connection.",
  inputSchema: PathInput,
  outputSchema: toolResult(
    z.object({
      extracts: z.array(
        z.object({
          datasourceId: z.string(),
          connectionMode: z.enum(["live", "extract"]),
          hasExtract: z.boolean(),
        }),
      ),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const r = await inspectWorkbookFile(inputData.twbxPath);
      return {
        extracts: r.datasources.map((d) => ({
          datasourceId: d.id,
          connectionMode: d.connectionMode,
          hasExtract: d.hasExtract,
        })),
      };
    }, "TWBX_INVALID"),
});

export const workbookTools = {
  listWorkbooks,
  inspectWorkbook,
  inspectDatasources,
  inspectConnections,
  inspectFields,
  inspectWorksheets,
  inspectCalculatedFields,
  inspectParameters,
  inspectExtracts,
};
