/**
 * Worksheet planning workflow (spec section 15).
 *
 * requirement -> inspect relevant metadata -> generate structured plan.
 * The agent produces a Zod-validated WorksheetPlan (structured output). Only real
 * field names are provided as context; the agent never sees raw XML (spec 57).
 */

import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { inspectWorkbookFile } from "../../tableau/inspect.js";
import {
  DatasourceLockSchema,
  WorksheetPlanSchema,
} from "../schemas/index.js";
import { supportedChartTypes } from "../../../templates/registry/index.js";

const inputSchema = z.object({
  twbxPath: z.string(),
  lock: DatasourceLockSchema,
  requirements: z.string().describe("Natural-language worksheet requirements"),
});

const outputSchema = z.object({ plan: WorksheetPlanSchema });

const generatePlan = createStep({
  id: "generatePlan",
  description:
    "Use the TableauPilot agent to convert requirements into a validated " +
    "WorksheetPlan using only real fields.",
  inputSchema,
  outputSchema,
  execute: async ({ inputData, mastra }) => {
    const inspection = await inspectWorkbookFile(inputData.twbxPath);
    const fieldList = inspection.fields
      .map((f) => `${f.name} (${f.role}, ${f.dataType})`)
      .join("; ");
    const agent = mastra.getAgent("tableauPilotAgent");
    const prompt =
      `Create a worksheet plan for the locked datasource ` +
      `"${inputData.lock.datasourceName}" (id ${inputData.lock.datasourceId}).\n\n` +
      `Requirements:\n${inputData.requirements}\n\n` +
      `Available fields: ${fieldList}\n\n` +
      `Supported chart types: ${supportedChartTypes().join(", ")}.\n` +
      `Use ONLY the listed fields. Set datasourceName to the locked datasource ` +
      `name and lockedDatasource to its name/id.`;
    const res = await agent.generate(prompt, {
      structuredOutput: { schema: WorksheetPlanSchema },
    });
    // Re-parse to apply Zod defaults and guarantee a fully-validated plan (spec 11).
    return { plan: WorksheetPlanSchema.parse(res.object) };
  },
});

export const worksheetPlanningWorkflow = createWorkflow({
  id: "worksheetPlanningWorkflow",
  description:
    "Convert natural-language requirements into a validated worksheet plan.",
  inputSchema,
  outputSchema,
})
  .then(generatePlan)
  .commit();
