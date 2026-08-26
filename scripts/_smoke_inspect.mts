import { inspectWorkbookFile } from "../src/tableau/inspect.js";

const r = await inspectWorkbookFile("./sample_workbook.twbx");
console.log("workbook:", r.workbookName, "version:", r.tableauVersion);
console.log("counts:", JSON.stringify(r.counts));
console.log(
  "datasource:",
  JSON.stringify(
    r.datasources.map((d) => ({
      id: d.id,
      name: d.name,
      mode: d.connectionMode,
      conn: d.connectionType,
      hasExtract: d.hasExtract,
      tables: d.tables.length,
    })),
  ),
);
console.log(
  "sample fields:",
  JSON.stringify(
    r.fields
      .filter((f) =>
        ["Sales", "Category", "Order Date", "Profit", "Region", "Sub-Category"].includes(
          f.name,
        ),
      )
      .map((f) => ({ n: f.name, t: f.dataType, r: f.role, agg: f.defaultAggregation })),
  ),
);
console.log(
  "measures:",
  r.fields.filter((f) => f.role === "measure").map((f) => f.name).join(", "),
);
console.log("worksheets:", r.worksheets.length);
