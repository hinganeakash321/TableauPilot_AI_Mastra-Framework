import { openTwbx, writeTwbx } from "../src/tableau/twbx.js";
import { inspectTwbXml } from "../src/tableau/twb.js";
import { applyWorksheets } from "../src/tableau/compiler/workbookCompiler.js";
import type { DatasourceLock } from "../src/mastra/schemas/datasource.js";
import type { WorksheetSpec } from "../src/mastra/schemas/worksheet.js";

const opened = await openTwbx("./sample_workbook.twbx");
const before = inspectTwbXml(opened.twbXml, "sample_workbook.twbx");
const ds = before.datasources[0]!;
const lock: DatasourceLock = {
  workbookPath: "./sample_workbook.twbx",
  datasourceName: ds.caption ?? ds.name,
  datasourceId: ds.id,
  connectionType: ds.connectionType,
  connectionMode: ds.connectionMode,
  locked: true,
};

const specs: WorksheetSpec[] = [
  {
    name: "TP Monthly Sales Trend",
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
    name: "TP Sales by Region",
    datasourceName: lock.datasourceName,
    chartType: "bar",
    columns: [{ name: "Region" }],
    rows: [{ name: "Sales", aggregation: "sum" }],
    marks: [],
    filters: [],
    calculations: [],
    parameters: [],
  },
  {
    name: "TP Top 10 Customers",
    datasourceName: lock.datasourceName,
    chartType: "horizontal_bar",
    rows: [{ name: "Customer Name" }],
    columns: [{ name: "Sales", aggregation: "sum" }],
    marks: [],
    filters: [
      { field: "Customer Name", topN: { field: "Customer Name", n: 10, byMeasure: "Sales", measureAggregation: "sum", direction: "top" } },
    ],
    calculations: [],
    parameters: [],
  },
  {
    name: "TP Total Sales KPI",
    datasourceName: lock.datasourceName,
    chartType: "kpi",
    rows: [],
    columns: [],
    marks: [{ markType: "text", encodings: [{ shelf: "label", field: { name: "Sales", aggregation: "sum" } }] }],
    filters: [],
    calculations: [],
    parameters: [],
    formatting: { title: "Total Sales" },
  },
];

const result = applyWorksheets(opened.twbXml, specs, lock, before.fields, {
  onCollision: "create_new_version",
});
console.log("apply errors:", JSON.stringify(result.errors));
console.log("added:", result.added);

await writeTwbx(
  "./workspace/output/sample_generated.twbx",
  opened.twbEntryName,
  result.twbXml,
  opened.entries,
);

const reopened = await openTwbx("./workspace/output/sample_generated.twbx");
const after = inspectTwbXml(reopened.twbXml, "sample_generated.twbx");
console.log("before worksheets:", before.counts.worksheets);
console.log("after worksheets:", after.counts.worksheets);
console.log("datasource preserved:", after.datasources[0]?.id === lock.datasourceId);
console.log("hyper preserved entries:", reopened.entries.map((e) => e.path));
