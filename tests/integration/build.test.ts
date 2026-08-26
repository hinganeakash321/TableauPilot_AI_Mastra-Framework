import { describe, it, expect } from "vitest";
import { inspectWorkbookFile } from "../../src/tableau/inspect.js";
import { buildWorkbook } from "../../src/tableau/build.js";
import { lockFromDatasource } from "../../src/tableau/lock.js";
import type { WorksheetSpec } from "../../src/mastra/schemas/worksheet.js";

const SAMPLE = "./sample_workbook.twbx";

async function lockAndFields() {
  const info = await inspectWorkbookFile(SAMPLE);
  const lock = lockFromDatasource(info.datasources[0]!, SAMPLE);
  return { info, lock };
}

describe("build pipeline (compile -> validate -> package)", () => {
  it("adds worksheets, preserves the datasource, and passes validation", async () => {
    const { info, lock } = await lockAndFields();
    const specs: WorksheetSpec[] = [
      {
        name: "TP Test Monthly Trend",
        datasourceName: lock.datasourceName,
        chartType: "line",
        columns: [{ name: "Order Date", dateDerivation: "month" }],
        rows: [{ name: "Sales", aggregation: "sum" }],
        marks: [],
        filters: [],
        calculations: [],
        parameters: [],
      },
      {
        name: "TP Test Top 10 Customers",
        datasourceName: lock.datasourceName,
        chartType: "horizontal_bar",
        rows: [{ name: "Customer Name" }],
        columns: [{ name: "Sales", aggregation: "sum" }],
        marks: [],
        filters: [
          {
            field: "Customer Name",
            topN: {
              field: "Customer Name",
              n: 10,
              byMeasure: "Sales",
              measureAggregation: "sum",
              direction: "top",
            },
          },
        ],
        calculations: [],
        parameters: [],
      },
    ];

    const result = await buildWorkbook({
      sourceTwbxPath: SAMPLE,
      specs,
      lock,
      fields: info.fields,
      collision: "create_new_version",
      outputName: "tp_build_test",
    });

    expect(result.success).toBe(true);
    expect(result.validationPassed).toBe(true);
    expect(result.datasourcePreserved).toBe(true);
    expect(result.worksheetsAdded).toContain("TP Test Monthly Trend");
    expect(result.outputPath).toBeDefined();

    // Re-inspect the produced TWBX to confirm the datasource id survived.
    const after = await inspectWorkbookFile(result.outputPath!);
    expect(after.datasources[0]!.id).toBe(lock.datasourceId);
    expect(after.counts.worksheets).toBeGreaterThanOrEqual(
      info.counts.worksheets + 2,
    );
  });

  it("rejects a spec that references a non-existent field", async () => {
    const { info, lock } = await lockAndFields();
    const specs: WorksheetSpec[] = [
      {
        name: "TP Bad Field",
        datasourceName: lock.datasourceName,
        chartType: "bar",
        columns: [{ name: "Nonexistent Field" }],
        rows: [{ name: "Sales", aggregation: "sum" }],
        marks: [],
        filters: [],
        calculations: [],
        parameters: [],
      },
    ];
    const result = await buildWorkbook({
      sourceTwbxPath: SAMPLE,
      specs,
      lock,
      fields: info.fields,
      collision: "create_new_version",
      outputName: "tp_build_badfield",
    });
    expect(result.success).toBe(false);
  });
});
