/**
 * Evaluation scenarios (spec section 80).
 *
 * These are golden-output evals over the DETERMINISTIC compiler layer: for each
 * canonical natural-language request, the expected WorksheetSpec is compiled and
 * the produced Tableau XML is asserted to contain the correct marks, pills, and
 * filters. This validates the "requirement -> spec -> XML" contract without
 * depending on a live LLM. Live agent evals (NL -> spec) are exercised in Studio.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { inspectWorkbookFile } from "../../src/tableau/inspect.js";
import { lockFromDatasource } from "../../src/tableau/lock.js";
import { compileWorksheet } from "../../src/tableau/compiler/worksheetCompiler.js";
import type { DatasourceLock } from "../../src/mastra/schemas/datasource.js";
import type { FieldInfo } from "../../src/mastra/schemas/workbook.js";
import type { WorksheetSpec } from "../../src/mastra/schemas/worksheet.js";

const SAMPLE = "./sample_workbook.twbx";
let lock: DatasourceLock;
let fields: FieldInfo[];

beforeAll(async () => {
  const info = await inspectWorkbookFile(SAMPLE);
  fields = info.fields;
  lock = lockFromDatasource(info.datasources[0]!, SAMPLE);
});

describe("eval: monthly sales trend", () => {
  it("compiles a line chart with MONTH(Order Date) x SUM(Sales)", () => {
    const spec: WorksheetSpec = {
      name: "Monthly Sales Trend",
      datasourceName: lock.datasourceName,
      chartType: "line",
      columns: [{ name: "Order Date", dateDerivation: "month" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("class='Line'");
    expect(worksheetXml).toContain("sum:Sales");
    expect(worksheetXml).toContain("Order Date");
  });
});

describe("eval: top 10 customers by sales", () => {
  it("compiles a bar chart with a Top-10 filter on Customer Name", () => {
    const spec: WorksheetSpec = {
      name: "Top 10 Customers",
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
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("class='Bar'");
    expect(worksheetXml).toContain("count='10'");
    expect(worksheetXml).toContain("Customer Name");
    expect(worksheetXml).toContain("SUM([Sales])");
  });
});

describe("eval: total sales KPI", () => {
  it("compiles a KPI text mark showing SUM(Sales)", () => {
    const spec: WorksheetSpec = {
      name: "Total Sales KPI",
      datasourceName: lock.datasourceName,
      chartType: "kpi",
      rows: [],
      columns: [],
      marks: [
        { markType: "text", encodings: [{ shelf: "label", field: { name: "Sales", aggregation: "sum" } }] },
      ],
      filters: [],
      calculations: [],
      parameters: [],
      formatting: { title: "Total Sales" },
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("<text column=");
    expect(worksheetXml).toContain("sum:Sales");
  });
});
