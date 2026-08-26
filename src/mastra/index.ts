/**
 * TableauPilot AI - Mastra instance (spec sections 4-6, 58-59, 83).
 *
 * Registers the agent, all workflows, shared storage, memory, logging, and
 * observability so everything is inspectable in Mastra Studio (`npm run dev`).
 *
 * Observability persists traces to the same LibSQL store used for memory and
 * workflow snapshots, with a SensitiveDataFilter applied so secrets never reach
 * traces (spec sections 70, 83).
 */

import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import {
  Observability,
  MastraStorageExporter,
} from "@mastra/observability";

import { storage } from "./storage.js";
import { uploadRoutes } from "./server/uploadRoutes.js";
import { tableauPilotAgent } from "./agents/tableauPilotAgent.js";
import {
  workbookInspectionWorkflow,
  worksheetPlanningWorkflow,
  worksheetGenerationWorkflow,
  twbxBuildWorkflow,
  tableauCloudDeploymentWorkflow,
} from "./workflows/index.js";

const logLevel = (process.env.LOG_LEVEL ?? "INFO").toLowerCase() as
  | "debug"
  | "info"
  | "warn"
  | "error";

export const mastra = new Mastra({
  agents: { tableauPilotAgent },
  workflows: {
    workbookInspectionWorkflow,
    worksheetPlanningWorkflow,
    worksheetGenerationWorkflow,
    twbxBuildWorkflow,
    tableauCloudDeploymentWorkflow,
  },
  storage,
  // Custom intake routes so users UPLOAD a .twbx (drag-and-drop page at /upload
  // or POST /upload) instead of pasting the binary into the Studio chat.
  server: { apiRoutes: uploadRoutes },
  logger: new PinoLogger({ name: "TableauPilot", level: logLevel }),
  observability: new Observability({
    // Persist traces to storage so Studio can render agent/workflow/tool spans.
    configs: {
      tableaupilot: {
        serviceName: "tableaupilot-ai",
        exporters: [new MastraStorageExporter()],
      },
    },
    // Redact secrets (API keys, PAT secrets, tokens) before any span is stored.
    sensitiveDataFilter: true,
  }),
});
