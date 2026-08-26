import { describe, it, expect } from "vitest";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { worksheetGenerationWorkflow } from "../../src/mastra/workflows/index.js";
import { inspectWorkbookFile } from "../../src/tableau/inspect.js";
import { lockFromDatasource } from "../../src/tableau/lock.js";
import type { WorksheetPlan } from "../../src/mastra/schemas/worksheet.js";

const SAMPLE = "./sample_workbook.twbx";

function makeMastra() {
  return new Mastra({
    storage: new LibSQLStore({ id: "test", url: ":memory:" }),
    workflows: { worksheetGenerationWorkflow },
    logger: false,
  });
}

async function makePlan(): Promise<{ plan: WorksheetPlan; lock: ReturnType<typeof lockFromDatasource> }> {
  const info = await inspectWorkbookFile(SAMPLE);
  const lock = lockFromDatasource(info.datasources[0]!, SAMPLE);
  const plan: WorksheetPlan = {
    lockedDatasource: { datasourceName: lock.datasourceName, datasourceId: lock.datasourceId },
    worksheets: [
      {
        name: "TP WF Region Sales",
        datasourceName: lock.datasourceName,
        chartType: "bar",
        columns: [{ name: "Region" }],
        rows: [{ name: "Sales", aggregation: "sum" }],
        marks: [],
        filters: [],
        calculations: [],
        parameters: [],
      },
    ],
  };
  return { plan, lock };
}

describe("worksheetGenerationWorkflow (human-in-the-loop)", () => {
  it("suspends for approval, then builds on approve", async () => {
    const mastra = makeMastra();
    const { plan, lock } = await makePlan();
    const run = await mastra.getWorkflow("worksheetGenerationWorkflow").createRun();
    const started = await run.start({
      inputData: {
        sourceTwbxPath: SAMPLE,
        lock,
        plan,
        collision: "create_new_version",
        outputName: "tp_wf_gen_ok",
      },
    });

    expect(started.status).toBe("suspended");
    if (started.status === "suspended") {
      const payload = started.suspendPayload.generateWorksheets;
      expect(payload.reason).toBe("approval_required");
      expect(payload.planPreview[0].name).toBe("TP WF Region Sales");
    }

    const resumed = await run.resume({
      step: "generateWorksheets",
      resumeData: { approved: true },
    });
    expect(resumed.status).toBe("success");
    if (resumed.status === "success") {
      expect(resumed.result.success).toBe(true);
      expect(resumed.result.cancelled).toBe(false);
      expect(resumed.result.worksheetsAdded).toContain("TP WF Region Sales");
    }
  });

  it("cancels without modification on reject", async () => {
    const mastra = makeMastra();
    const { plan, lock } = await makePlan();
    const run = await mastra.getWorkflow("worksheetGenerationWorkflow").createRun();
    await run.start({
      inputData: {
        sourceTwbxPath: SAMPLE,
        lock,
        plan,
        collision: "create_new_version",
        outputName: "tp_wf_gen_cancel",
      },
    });
    const resumed = await run.resume({
      step: "generateWorksheets",
      resumeData: { approved: false },
    });
    expect(resumed.status).toBe("success");
    if (resumed.status === "success") {
      expect(resumed.result.cancelled).toBe(true);
      expect(resumed.result.success).toBe(false);
      expect(resumed.result.worksheetsAdded).toEqual([]);
    }
  });
});
