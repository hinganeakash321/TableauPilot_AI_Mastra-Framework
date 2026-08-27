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
import { applyWorksheets } from "../../src/tableau/compiler/workbookCompiler.js";
import { addCalculatedFields } from "../../src/tableau/compiler/calculatedFields.js";
import { openTwbx } from "../../src/tableau/twbx.js";
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
    // The Top-N selection + ordering lives entirely in the filter's groupfilters.
    // We must NOT emit a standalone in-view <computed-sort>: stricter Tableau
    // runtimes reject it ("no declaration found for element 'computed-sort'") and
    // refuse to open the workbook.
    expect(worksheetXml).not.toContain("computed-sort");
  });
});

describe("eval: categorical filters", () => {
  it("wraps multiple members in a groupfilter union (not sibling members)", () => {
    const spec: WorksheetSpec = {
      name: "Sales by Category (filtered)",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [{ field: "Category", operator: "in", values: ["Furniture", "Technology"] }],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("class='categorical'");
    expect(worksheetXml).toContain("function='union'");
    // Two member children under the union, both quoted strings.
    expect(worksheetXml).toContain("member='&quot;Furniture&quot;'");
    expect(worksheetXml).toContain("member='&quot;Technology&quot;'");
    // Slices register the filtered dimension.
    expect(worksheetXml).toContain("[none:Category:nk]</column>");
  });

  it("writes a single string member flat (no union) with quotes", () => {
    const spec: WorksheetSpec = {
      name: "Furniture only",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Sub-Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [{ field: "Category", operator: "equals", values: ["Furniture"] }],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).not.toContain("function='union'");
    expect(worksheetXml).toContain(
      "<groupfilter function='member' level='[none:Category:nk]' member='&quot;Furniture&quot;'",
    );
  });

  it("filters a date by year using the discrete yr: part with an unquoted member", () => {
    const spec: WorksheetSpec = {
      name: "Sales in 2026",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Segment" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [{ field: "Order Date", operator: "equals", values: [2026] }],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("[yr:Order Date:ok]");
    expect(worksheetXml).toContain("member='2026'");
    expect(worksheetXml).not.toContain("member='&quot;2026&quot;'");
  });

  it("applies MULTIPLE filters on one sheet (each its own <filter>, one <slices>)", () => {
    const spec: WorksheetSpec = {
      name: "Sub-Category (multi-filtered)",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Sub-Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [
        { field: "Category", operator: "in", values: ["Furniture", "Technology"] },
        { field: "Region", operator: "equals", values: ["West"] },
        { field: "Order Date", operator: "equals", values: [2026], dateDerivation: "year" },
        { field: "Sales", operator: "between", values: [100, 5000] },
      ],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    // One <filter> per spec filter.
    expect((worksheetXml.match(/<filter /g) ?? []).length).toBe(4);
    // Exactly one <slices> block, holding the three dimension filters
    // (the measure range does not add a slice).
    expect((worksheetXml.match(/<slices>/g) ?? []).length).toBe(1);
    expect(worksheetXml).toContain("[none:Category:nk]</column>");
    expect(worksheetXml).toContain("[none:Region:nk]</column>");
    expect(worksheetXml).toContain("[yr:Order Date:ok]</column>");
    // Distinct filter classes present.
    expect(worksheetXml).toContain("function='union'"); // multi-member Category
    expect(worksheetXml).toContain("class='quantitative'"); // Sales range
  });

  it("adds a filter to CONTEXT when context=true (context='true' on the filter)", () => {
    const spec: WorksheetSpec = {
      name: "Sales by Sub-Category (context)",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Sub-Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [
        { field: "Category", operator: "equals", values: ["Furniture"], context: true },
      ],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("class='categorical'");
    expect(worksheetXml).toContain("context='true'");
  });

  it("filters a measure as a quantitative range", () => {
    const spec: WorksheetSpec = {
      name: "High value sub-categories",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Sub-Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [{ field: "Sales", operator: "between", values: [100, 5000] }],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("class='quantitative'");
    expect(worksheetXml).toContain("<min>100</min>");
    expect(worksheetXml).toContain("<max>5000</max>");
  });
});

describe("eval: calculated fields", () => {
  it("creates a calc field in the datasource and lets a worksheet reference it", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    // Use a novel field name that does not already exist in the sample.
    const spec: WorksheetSpec = {
      name: "Avg Order Value by Category",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Avg Order Value", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [
        {
          name: "Avg Order Value",
          formula: "SUM([Sales]) / COUNTD([Order ID])",
          dataType: "real",
          role: "measure",
        },
      ],
      parameters: [],
    };
    const res = applyWorksheets(twbXml, [spec], lock, fields, {
      onCollision: "create_new_version",
    });
    expect(res.errors).toHaveLength(0);
    // A synthetic calc column was created in the datasource with the formula.
    expect(res.calculationsAdded).toHaveLength(1);
    const synthetic = res.calculationsAdded[0]!.name;
    expect(synthetic).toMatch(/^Calculation_\d+$/);
    expect(res.twbXml).toContain("caption='Avg Order Value'");
    expect(res.twbXml).toContain(
      "<calculation class='tableau' formula='SUM([Sales]) / COUNTD([Order ID])' />",
    );
    // The worksheet references the synthetic calc column, not the display name.
    expect(res.twbXml).toContain(`[${synthetic}]`);
  });

  it("inserts the calc at DATASOURCE level, never inside a relation's <columns> (multi-connection)", () => {
    // Mimics an Excel/extract workbook: a datasource with TWO connections, each with
    // a <relation><columns><column/></columns> whose content model is EMPTY. A calc
    // <column> placed there is invalid ("element 'calculation' is not allowed for
    // content model 'EMPTY'"). It must land at datasource level instead.
    const twb =
      "<workbook><datasources>" +
      "<datasource name='ds1'>" +
      "<connection class='federated'>" +
      "<named-connections><named-connection name='n'>" +
      "<connection class='excel-direct' filename='x.xlsx' />" +
      "</named-connection></named-connections>" +
      "<relation type='collection'><relation name='Orders' table='[O$]' type='table'>" +
      "<columns gridOrigin='A1'><column datatype='integer' name='Row ID' ordinal='0' /></columns>" +
      "</relation></relation>" +
      "<metadata-records></metadata-records>" +
      "</connection>" +
      "<aliases enabled='yes' />" +
      "<column datatype='real' name='[Sales]' role='measure' type='quantitative' />" +
      "<_.fcp.ObjectModelEncapsulateLegacy.true...>" +
      "<connection class='federated'><relation><columns>" +
      "<column datatype='integer' name='X' ordinal='0' /></columns></relation></connection>" +
      "</_.fcp.ObjectModelEncapsulateLegacy.true...>" +
      "</datasource></datasources></workbook>";

    const res = addCalculatedFields(
      twb,
      { datasourceId: "ds1", datasourceName: "ds1" } as DatasourceLock,
      [{ name: "Profit Ratio2", formula: "SUM([Profit]) / SUM([Sales])", dataType: "real", role: "measure" }],
      [],
    );
    expect(res.errors).toHaveLength(0);
    expect(res.created).toHaveLength(1);
    // The calc column exists...
    expect(res.twbXml).toContain("caption='Profit Ratio2'");
    // ...and NO <calculation> ever sits inside a relation's <columns> block.
    for (const m of res.twbXml.matchAll(/<columns\b[^>]*>[\s\S]*?<\/columns>/g)) {
      expect(m[0]).not.toContain("calculation");
    }
    // It is a direct child of <datasource> (appears before the [Sales] column here).
    const calcIdx = res.twbXml.indexOf("caption='Profit Ratio2'");
    const salesIdx = res.twbXml.indexOf("name='[Sales]'");
    expect(calcIdx).toBeGreaterThan(0);
    expect(calcIdx).toBeLessThan(salesIdx);
  });

  it("reuses an existing field/caption instead of creating a duplicate", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const spec: WorksheetSpec = {
      name: "Sales by Category (dup calc)",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      // "Sales" already exists; must not be recreated as a calc.
      calculations: [{ name: "Sales", formula: "SUM([Sales])" }],
      parameters: [],
    };
    const res = applyWorksheets(twbXml, [spec], lock, fields, {
      onCollision: "create_new_version",
    });
    expect(res.errors).toHaveLength(0);
    expect(res.twbXml).not.toContain("SUM([Sales])' />");
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
    // Formatting must mirror the sample workbook's "Sample KPI Chart".
    expect(worksheetXml).toContain("<customized-label>");
    expect(worksheetXml).toContain("fontcolor='#1b1b1b'");
    expect(worksheetXml).toContain("fontsize='18'");
    expect(worksheetXml).toContain("fontsize='12'");
    expect(worksheetXml).toContain("<![CDATA[<");
    expect(worksheetXml).toContain(">Total Sales</run>");
    expect(worksheetXml).toContain("<format attr='text-align' value='center' />");
    expect(worksheetXml).toContain("<format attr='mark-labels-show' value='true' />");
    expect(worksheetXml).toContain("<format attr='mark-labels-cull' value='true' />");
    // The line-break run must match the sample (leading U+00C6 + newline entity),
    // otherwise Tableau collapses the whitespace-only run and the value + caption
    // render on the SAME line.
    expect(worksheetXml).toContain("<run>\u00C6&#10;</run>");
  });
});

describe("eval: bar chart formatting matches the sample", () => {
  it("adds value labels + measure number format like the sample bar chart", () => {
    const spec: WorksheetSpec = {
      name: "Sales by Category",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    // Data labels shown, like the sample vertical/horizontal bar charts.
    expect(worksheetXml).toContain("<text column=");
    expect(worksheetXml).toContain("<format attr='mark-labels-show' value='true' />");
    expect(worksheetXml).toContain("<format attr='mark-labels-cull' value='true' />");
    // Measure number format applied at the cell level (Sales carries a currency
    // default-format in the sample datasource).
    expect(worksheetXml).toContain("<style-rule element='cell'>");
    expect(worksheetXml).toContain("attr='text-format'");
    expect(worksheetXml).toContain("sum:Sales");
  });

  it("does NOT force labels on a line chart (matches sample)", () => {
    const spec: WorksheetSpec = {
      name: "Sales Trend",
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
    expect(worksheetXml).not.toContain("mark-labels-show");
  });

  it("honors formatting.showLabels=true on a line chart", () => {
    const spec: WorksheetSpec = {
      name: "Sales Trend Labeled",
      datasourceName: lock.datasourceName,
      chartType: "line",
      columns: [{ name: "Order Date", dateDerivation: "month" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
      formatting: { showLabels: true },
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("<format attr='mark-labels-show' value='true' />");
  });
});
