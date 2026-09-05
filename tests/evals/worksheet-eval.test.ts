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
import { isAggregateFormula } from "../../src/tableau/compiler/columnInstance.js";
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

describe("eval: multi-pill shelves", () => {
  it("joins two discrete dimensions on rows with ' / ' inside parentheses", () => {
    const spec: WorksheetSpec = {
      name: "Profit by Category",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      rows: [{ name: "Category" }, { name: "Sub-Category" }],
      columns: [{ name: "Profit", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    // Must be an operator-joined expression, never bare concatenation
    // ("unable to associate operators with operands").
    expect(worksheetXml).toContain(
      "<rows>([" + lock.datasourceId + "].[none:Category:nk] / [" +
        lock.datasourceId + "].[none:Sub-Category:nk])</rows>",
    );
    expect(worksheetXml).not.toContain("[none:Category:nk][");
  });

  it("joins two measures on rows with ' + ' inside parentheses", () => {
    const spec: WorksheetSpec = {
      name: "Sales and Profit by Category",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [
        { name: "Sales", aggregation: "sum" },
        { name: "Profit", aggregation: "sum" },
      ],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain(
      "<rows>([" + lock.datasourceId + "].[sum:Sales:qk] + [" +
        lock.datasourceId + "].[sum:Profit:qk])</rows>",
    );
  });

  it("emits a single pill bare (no wrapping parentheses)", () => {
    const spec: WorksheetSpec = {
      name: "Profit by Region",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      rows: [{ name: "Region" }],
      columns: [{ name: "Profit", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain(
      "<rows>[" + lock.datasourceId + "].[none:Region:nk]</rows>",
    );
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

describe("eval: derived-field source columns", () => {
  it("co-declares a derived field's source column (bin/group/calc) when used", () => {
    // A categorical-bin-like derived dimension that depends on a source column.
    const derived: FieldInfo = {
      name: "Age Group",
      caption: "Age Group",
      dataType: "string",
      role: "dimension",
      isCalculated: false,
      aggregated: false,
      datasourceId: lock.datasourceId,
      dependsOn: ["Region"], // "Region" is a real sample field, not used directly
    };
    const spec: WorksheetSpec = {
      name: "By Age Group",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Age Group" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, [...fields, derived]);
    // The derived field itself is declared...
    expect(worksheetXml).toContain("name='[Age Group]'");
    // ...and its SOURCE column is co-declared even though it's not used directly.
    expect(worksheetXml).toContain("name='[Region]'");
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

  it("uses AGG(field) for an already-aggregated calc, not SUM(calc)", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    // Profit Ratio = SUM([Profit]) / SUM([Sales]) is ALREADY aggregated.
    // Use a novel name; "Profit Ratio" already exists in the sample as a
    // row-level calc and would be reused instead of created.
    const spec: WorksheetSpec = {
      name: "Agg Profit Ratio by Category",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      // No aggregation set on purpose - the compiler must apply AGG, not SUM.
      rows: [{ name: "Profit Margin Agg" }],
      marks: [],
      filters: [],
      calculations: [
        {
          name: "Profit Margin Agg",
          formula: "SUM([Profit]) / SUM([Sales])",
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
    const synthetic = res.calculationsAdded[0]!.name;
    // Placed as AGG(field): usr / User instance, NEVER re-aggregated with sum.
    expect(res.twbXml).toContain(`[usr:${synthetic}:qk]`);
    expect(res.twbXml).toContain("derivation='User'");
    expect(res.twbXml).not.toContain(`[sum:${synthetic}:qk]`);
  });

  it("still applies SUM to a row-level calc (no top-level aggregate)", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const spec: WorksheetSpec = {
      name: "Unit Margin by Category",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Unit Margin" }],
      marks: [],
      filters: [],
      // Row-level: no aggregate function -> Tableau aggregates it with SUM.
      calculations: [
        { name: "Unit Margin", formula: "[Profit] / [Quantity]", dataType: "real", role: "measure" },
      ],
      parameters: [],
    };
    const res = applyWorksheets(twbXml, [spec], lock, fields, {
      onCollision: "create_new_version",
    });
    expect(res.errors).toHaveLength(0);
    const synthetic = res.calculationsAdded[0]!.name;
    expect(res.twbXml).toContain(`[sum:${synthetic}:qk]`);
    expect(res.twbXml).not.toContain(`[usr:${synthetic}:qk]`);
  });

  it("isAggregateFormula detects top-level aggregates but ignores LOD-nested ones", () => {
    expect(isAggregateFormula("SUM([Profit]) / SUM([Sales])")).toBe(true);
    expect(isAggregateFormula("COUNTD([Order ID])")).toBe(true);
    expect(isAggregateFormula("[Profit] / [Sales]")).toBe(false);
    // Aggregate nested inside an LOD is re-aggregated at viz level -> not top-level.
    expect(isAggregateFormula("{ FIXED [Category] : COUNTD([Quantity]) }")).toBe(false);
    // Function name appearing only inside a string literal must not match.
    expect(isAggregateFormula("IF [Region] = 'SUM(x)' THEN 1 ELSE 0 END")).toBe(false);
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

  it("emits a formatted <layout-options><title> when titleFormat is set", () => {
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
      formatting: {
        title: "Category Performance",
        titleFormat: {
          fontSize: 14,
          color: "#0044cc",
          bold: true,
          alignment: "center",
          fontName: "Tableau Bold",
        },
      },
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("<layout-options>");
    expect(worksheetXml).toContain("<title>");
    expect(worksheetXml).toContain(
      "<run bold='true' fontalignment='1' fontcolor='#0044cc' fontname='Tableau Bold' fontsize='14'>Category Performance</run>",
    );
    // The layout-options block appears before the <table> content.
    expect(worksheetXml.indexOf("<layout-options>")).toBeLessThan(
      worksheetXml.indexOf("<table>"),
    );
  });

  it("does NOT emit layout-options when no titleFormat is given", () => {
    const spec: WorksheetSpec = {
      name: "Plain Sheet",
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
    expect(worksheetXml).not.toContain("<layout-options>");
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

describe("eval: chart colors (per-member hex palette)", () => {
  it("emits a color palette style-rule with per-member hex maps", () => {
    const spec: WorksheetSpec = {
      name: "Sales by Category Colored",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [
        {
          encodings: [
            {
              shelf: "color",
              field: {
                name: "Category",
                colors: [
                  { value: "Furniture", color: "#4e79a7" },
                  { value: "Technology", color: "#f28e2b" },
                ],
              },
            },
          ],
        },
      ],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("<style-rule element='mark'>");
    expect(worksheetXml).toContain(
      "<encoding attr='color' field='[none:Category:nk]' type='palette'>",
    );
    expect(worksheetXml).toContain("<map to='#4e79a7'>");
    expect(worksheetXml).toContain("<bucket>&quot;Furniture&quot;</bucket>");
    expect(worksheetXml).toContain("<map to='#f28e2b'>");
    expect(worksheetXml).toContain("<bucket>&quot;Technology&quot;</bucket>");
  });
});

describe("eval: discrete vs continuous conversion", () => {
  it("continuous=false makes a measure discrete (ordinal/ok)", () => {
    const spec: WorksheetSpec = {
      name: "Discrete Sales",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum", continuous: false }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("[sum:Sales:ok]");
    expect(worksheetXml).not.toContain("[sum:Sales:qk]");
  });

  it("continuous=true makes a date part a continuous (green) axis", () => {
    const spec: WorksheetSpec = {
      name: "Continuous Month",
      datasourceName: lock.datasourceName,
      chartType: "bar", // bar would normally be a discrete date part
      columns: [{ name: "Order Date", dateDerivation: "month", continuous: true }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
    };
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    // Continuous month -> tmn:...:qk with a Month-Trunc derivation.
    expect(worksheetXml).toContain("tmn:Order Date:qk");
    expect(worksheetXml).toContain("derivation='Month-Trunc'");
  });
});

describe("eval: reference / average lines", () => {
  it("emits a <reference-line formula='average'> on the measure axis", () => {
    const spec = {
      name: "Sales with Avg Line",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      filters: [],
      calculations: [],
      parameters: [],
      referenceLines: [{ field: "Sales", formula: "average", scope: "per-table" }],
    } as unknown as WorksheetSpec;
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("<reference-line");
    expect(worksheetXml).toContain("formula='average'");
    expect(worksheetXml).toContain("scope='per-table'");
    expect(worksheetXml).toContain("value-column='[" + lock.datasourceId + "].[sum:Sales:qk]'");
  });
});

describe("eval: grand totals", () => {
  it("sets total='true' on the rows and cols shelves", () => {
    const spec = {
      name: "Totals Table",
      datasourceName: lock.datasourceName,
      chartType: "text_table",
      rows: [{ name: "State" }],
      columns: [{ name: "Ship Mode" }],
      marks: [{ encodings: [{ shelf: "label", field: { name: "Sales", aggregation: "sum" } }] }],
      filters: [],
      calculations: [],
      parameters: [],
      grandTotals: { row: true, column: true },
    } as unknown as WorksheetSpec;
    const { worksheetXml } = compileWorksheet(spec, lock, fields);
    expect(worksheetXml).toContain("<rows total='true'>");
    expect(worksheetXml).toContain("<cols total='true'>");
  });
});

describe("eval: parameters + parameter-driven Top-N", () => {
  it("creates a parameter and references it in a Top-N filter", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const spec = {
      name: "Top N Customers by Param",
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
            n: 5,
            byMeasure: "Sales",
            direction: "top",
            nParameter: "Eval Top N",
          },
        },
      ],
      calculations: [],
      parameters: [
        { name: "Eval Top N", dataType: "integer", currentValue: "5", domain: "all" },
      ],
    } as unknown as WorksheetSpec;
    const res = applyWorksheets(twbXml, [spec], lock, fields, {
      onCollision: "create_new_version",
    });
    expect(res.errors).toHaveLength(0);
    expect(res.parametersAdded.some((p) => p.caption === "Eval Top N")).toBe(true);
    const created = res.parametersAdded.find((p) => p.caption === "Eval Top N")!;
    // The Parameters datasource carries the new column.
    expect(res.twbXml).toContain("caption='Eval Top N'");
    // The Top-N filter reads the count from the parameter.
    expect(res.twbXml).toContain(`count='[Parameters].[${created.name}]'`);
    // The worksheet declares a Parameters dependency.
    expect(res.twbXml).toContain(
      "<datasource-dependencies datasource='Parameters'>",
    );
  });

  it("reuses the sample workbook's existing 'Top N' parameter (no duplicate)", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const spec = {
      name: "Top N Reuse",
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
            n: 5,
            byMeasure: "Sales",
            direction: "top",
            nParameter: "Top N",
          },
        },
      ],
      calculations: [],
      parameters: [{ name: "Top N", dataType: "integer", currentValue: "5", domain: "all" }],
    } as unknown as WorksheetSpec;
    // Count "Top N" columns INSIDE the Parameters datasource only (worksheet
    // dependency blocks also carry the caption and would inflate a naive count).
    const paramsDsCount = (s: string) => {
      const block =
        /<datasource\b[^>]*\bname='Parameters'[^>]*>[\s\S]*?<\/datasource>/.exec(
          s,
        )?.[0] ?? "";
      return (block.match(/caption='Top N'/g) ?? []).length;
    };
    const before = paramsDsCount(twbXml);
    const res = applyWorksheets(twbXml, [spec], lock, fields, {
      onCollision: "create_new_version",
    });
    expect(res.errors).toHaveLength(0);
    // Existing param reused: the Parameters datasource still has exactly one "Top N".
    expect(before).toBe(1);
    expect(paramsDsCount(res.twbXml)).toBe(1);
    // reuse maps to the existing internal name, not a new Parameter N.
    expect(res.parametersAdded).toContainEqual({ caption: "Top N", name: "Parameter 1" });
    // The Top-N still points at the existing [Parameter 1].
    expect(res.twbXml).toContain("count='[Parameters].[Parameter 1]'");
  });
});
