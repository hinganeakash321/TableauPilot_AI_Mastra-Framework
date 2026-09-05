/**
 * Dashboard evaluation scenarios.
 *
 * Golden-output evals over the DETERMINISTIC dashboard compiler + filter injector,
 * plus an end-to-end build (2 worksheets + 1 dashboard) that must validate and
 * package a well-formed TWBX. Mirrors the two sample dashboards' patterns.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { inspectWorkbookFile } from "../../src/tableau/inspect.js";
import { lockFromDatasource } from "../../src/tableau/lock.js";
import { compileDashboard } from "../../src/tableau/compiler/dashboardCompiler.js";
import { injectApplyToAllFilters } from "../../src/tableau/compiler/dashboardFilters.js";
import {
  applyWorksheets,
  applyDashboards,
  existingDashboardNames,
} from "../../src/tableau/compiler/workbookCompiler.js";
import {
  buildWorkbook,
  compileWorkbookToWorking,
  validateTwbxFile,
} from "../../src/tableau/build.js";
import { openTwbx } from "../../src/tableau/twbx.js";
import { validateTwbXml } from "../../src/tableau/validators/index.js";
import { DashboardSpecSchema } from "../../src/mastra/schemas/dashboard.js";
import type { ParameterColumn } from "../../src/tableau/compiler/parameters.js";
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

function sheet(name: string, chartType: WorksheetSpec["chartType"]): WorksheetSpec {
  return {
    name,
    datasourceName: lock.datasourceName,
    chartType,
    columns: [{ name: "Category" }],
    rows: [{ name: "Sales", aggregation: "sum" }],
    marks: [],
    filters: [],
    calculations: [],
    parameters: [],
  };
}

describe("eval: dashboard compiler", () => {
  it("emits style/size/zones/title/filter zones + a window with viewpoints", () => {
    const spec = DashboardSpecSchema.parse({
      name: "Overview",
      title: "Superstore Analysis",
      sizeMode: "automatic",
      rows: [
        { sheets: [{ worksheet: "Sales by Category" }, { worksheet: "Sales Trend" }] },
      ],
      filters: { fields: ["Region", "Segment"] },
    });
    const compiled = compileDashboard(spec, lock, fields, [
      "Sales by Category",
      "Sales Trend",
    ]);

    // Background + automatic size.
    expect(compiled.dashboardXml).toContain(
      "<style-rule element='table'>",
    );
    expect(compiled.dashboardXml).toContain(
      "<format attr='background-color' value='#e6e6e6' />",
    );
    expect(compiled.dashboardXml).toContain("sizing-mode='automatic'");
    // Title band text.
    expect(compiled.dashboardXml).toContain(">Superstore Analysis</run>");
    // Must NOT emit the attribute some Tableau versions reject at load time
    // ("attribute 'enable-sort-zone-taborder' is not declared for element 'dashboard'").
    expect(compiled.dashboardXml).not.toContain("enable-sort-zone-taborder");
    // A zones tree with a layout-basic root.
    expect(compiled.dashboardXml).toContain("<zones>");
    expect(compiled.dashboardXml).toContain("type-v2='layout-basic'");
    // Worksheet zones reference the sheets by name.
    expect(compiled.dashboardXml).toContain("name='Sales by Category'");
    expect(compiled.dashboardXml).toContain("name='Sales Trend'");
    // Filter zones: multi-select dropdown + Apply + relevant values.
    expect(compiled.dashboardXml).toContain("mode='checkdropdown'");
    expect(compiled.dashboardXml).toContain("show-apply='true'");
    expect(compiled.dashboardXml).toContain("values='relevant'");
    expect(compiled.dashboardXml).toContain("type-v2='filter'");
    expect(compiled.dashboardXml).toContain("[none:Region:nk]");
    expect(compiled.dashboardXml).toContain("[none:Segment:nk]");
    // datasource-dependencies for the filter fields.
    expect(compiled.dashboardXml).toContain("<datasource-dependencies");
    // Window with a viewpoint per referenced worksheet.
    expect(compiled.windowXml).toContain("class='dashboard'");
    expect(compiled.windowXml).toContain("<viewpoint name='Sales by Category'>");
    expect(compiled.windowXml).toContain("<viewpoint name='Sales Trend'>");
    // Well-formed XML.
    expect(validateTwbXml(`<workbook>${compiled.dashboardXml}</workbook>`).valid).toBe(true);
  });

  it("renders a parameter control (paramctrl) in the filters panel", () => {
    const spec = DashboardSpecSchema.parse({
      name: "TopN",
      rows: [{ sheets: [{ worksheet: "Top Products" }] }],
      filters: { fields: ["Region"], parameters: ["Top N"] },
    });
    const paramCols: ParameterColumn[] = [
      {
        caption: "Top N",
        name: "Parameter 1",
        datatype: "integer",
        paramDomainType: "any",
        role: "measure",
        type: "quantitative",
        value: "10",
        formula: "10",
      },
    ];
    const compiled = compileDashboard(
      spec,
      lock,
      fields,
      ["Top Products"],
      paramCols,
    );
    // Parameter control zone modeled on the sample workbook.
    expect(compiled.dashboardXml).toContain("type-v2='paramctrl'");
    expect(compiled.dashboardXml).toContain("param='[Parameters].[Parameter 1]'");
    expect(compiled.dashboardXml).toContain("mode='type_in'");
    // Field filter still present alongside the parameter control.
    expect(compiled.dashboardXml).toContain("type-v2='filter'");
    expect(compiled.dashboardXml).toContain("[none:Region:nk]");
    expect(
      validateTwbXml(`<workbook>${compiled.dashboardXml}</workbook>`).valid,
    ).toBe(true);
  });

  it("errors when a filter-panel parameter does not exist", () => {
    const spec = DashboardSpecSchema.parse({
      name: "TopN",
      rows: [{ sheets: [{ worksheet: "Top Products" }] }],
      filters: { parameters: ["Nonexistent"] },
    });
    expect(() =>
      compileDashboard(spec, lock, fields, ["Top Products"], []),
    ).toThrow(/does not exist/);
  });

  it("supports fixed sizing with width/height", () => {
    const spec = DashboardSpecSchema.parse({
      name: "Fixed",
      sizeMode: "fixed",
      width: 1200,
      height: 1200,
      rows: [{ sheets: [{ worksheet: "Sales by Category" }] }],
    });
    const compiled = compileDashboard(spec, lock, fields, ["Sales by Category"]);
    expect(compiled.dashboardXml).toContain("sizing-mode='fixed'");
    expect(compiled.dashboardXml).toContain("maxwidth='1200'");
    expect(compiled.dashboardXml).toContain("minheight='1200'");
  });

  it("supports RANGE sizing with min/max bounds", () => {
    const spec = DashboardSpecSchema.parse({
      name: "Ranged",
      sizeMode: "range",
      minWidth: 800,
      minHeight: 600,
      maxWidth: 1400,
      maxHeight: 1050,
      rows: [{ sheets: [{ worksheet: "Sales by Category" }] }],
    });
    const compiled = compileDashboard(spec, lock, fields, ["Sales by Category"]);
    expect(compiled.dashboardXml).toContain(
      "<size maxheight='1050' maxwidth='1400' minheight='600' minwidth='800' sizing-mode='range' />",
    );
  });

  it("applies range defaults and clamps max >= min", () => {
    const spec = DashboardSpecSchema.parse({
      name: "RangedDefaults",
      sizeMode: "range",
      // Only a min is given; max should default and be clamped to at least min.
      minWidth: 1500,
      rows: [{ sheets: [{ worksheet: "Sales by Category" }] }],
    });
    const compiled = compileDashboard(spec, lock, fields, ["Sales by Category"]);
    // maxWidth default (1200) is clamped up to the given minWidth (1500).
    expect(compiled.dashboardXml).toContain("minwidth='1500'");
    expect(compiled.dashboardXml).toContain("maxwidth='1500'");
    expect(compiled.dashboardXml).toContain("sizing-mode='range'");
  });

  it("sizes containers by explicit width/height (px on fixed board)", () => {
    const spec = DashboardSpecSchema.parse({
      name: "SizedContainers",
      sizeMode: "fixed",
      width: 1200,
      height: 900,
      rows: [
        {
          height: 600,
          sheets: [
            { worksheet: "Sales by Category", width: 800 },
            { worksheet: "Sales Trend", width: 400 },
          ],
        },
      ],
    });
    const compiled = compileDashboard(spec, lock, fields, [
      "Sales by Category",
      "Sales Trend",
    ]);
    const xml = compiled.dashboardXml;
    // Cells split 800:400 = 2:1 of the row width; first cell wider than second.
    // Assert the two worksheet zones have different widths (proportional sizing
    // took effect) and the XML is well-formed.
    const catW = /\bw='(\d+)'[^>]*name='Sales by Category'/.exec(xml);
    const trendW = /\bw='(\d+)'[^>]*name='Sales Trend'/.exec(xml);
    expect(catW).not.toBeNull();
    expect(trendW).not.toBeNull();
    expect(Number(catW![1])).toBeGreaterThan(Number(trendW![1]));
    expect(validateTwbXml(`<workbook>${xml}</workbook>`).valid).toBe(true);
  });

  it("throws when a referenced worksheet does not exist", () => {
    const spec = DashboardSpecSchema.parse({
      name: "Broken",
      rows: [{ sheets: [{ worksheet: "Does Not Exist" }] }],
    });
    expect(() => compileDashboard(spec, lock, fields, ["Sales by Category"])).toThrow();
  });

  it("applies layout formatting (padding, border, colors, title format)", () => {
    const spec = DashboardSpecSchema.parse({
      name: "Styled",
      title: "My Report",
      backgroundColor: "#222222",
      containerBackground: "#fafafa",
      outerPadding: 16,
      innerPadding: 10,
      border: { color: "#cccccc", style: "solid", width: 2 },
      titleFormat: {
        fontSize: 22,
        color: "#0044cc",
        bold: true,
        alignment: "left",
        fontName: "Tableau Bold",
        backgroundColor: "#eeeeee",
      },
      rows: [{ sheets: [{ worksheet: "Sales by Category" }] }],
      filters: {
        fields: ["Region"],
        panelTitle: "Slice by",
        panelTitleFormat: { fontSize: 14, color: "#333333", alignment: "right" },
      },
    });
    const compiled = compileDashboard(spec, lock, fields, ["Sales by Category"]);
    const xml = compiled.dashboardXml;

    // Dashboard color + container color.
    expect(xml).toContain("<format attr='background-color' value='#222222' />");
    expect(xml).toContain("<format attr='background-color' value='#fafafa' />");
    // Outer padding (root zone margin) + inner padding (container margin).
    expect(xml).toContain("<format attr='margin' value='16' />");
    expect(xml).toContain("<format attr='margin' value='10' />");
    // Border on containers.
    expect(xml).toContain("<format attr='border-color' value='#cccccc' />");
    expect(xml).toContain("<format attr='border-style' value='solid' />");
    expect(xml).toContain("<format attr='border-width' value='2' />");
    // Title band formatting (left = fontalignment 0) + its background.
    expect(xml).toContain(
      "<run bold='true' fontalignment='0' fontcolor='#0044cc' fontname='Tableau Bold' fontsize='22'>My Report</run>",
    );
    expect(xml).toContain("<format attr='background-color' value='#eeeeee' />");
    // Filter panel heading formatting (right = fontalignment 2).
    expect(xml).toContain(
      "fontalignment='2' fontcolor='#333333' fontname='Tableau Semibold' fontsize='14'>Slice by</run>",
    );
    // Well-formed.
    expect(validateTwbXml(`<workbook>${xml}</workbook>`).valid).toBe(true);
  });
});

describe("eval: apply-to-all filter injection", () => {
  it("adds context filter-group filters + column-instances to every datasource worksheet", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const applied = applyWorksheets(
      twbXml,
      [sheet("Sales by Category", "bar")],
      lock,
      fields,
      { onCollision: "create_new_version" },
    );
    expect(applied.errors).toHaveLength(0);

    const spec = DashboardSpecSchema.parse({
      name: "Filtered",
      rows: [{ sheets: [{ worksheet: applied.added[0]! }] }],
      filters: { fields: ["Region"] },
    });
    const compiled = compileDashboard(spec, lock, fields, applied.added);

    const injected = injectApplyToAllFilters(
      applied.twbXml,
      lock,
      compiled.filterFields,
    );
    expect(injected.worksheetsInjected).toBeGreaterThan(0);
    // Context filter with a shared filter-group + select-all groupfilter.
    expect(injected.twbXml).toContain("context='true'");
    expect(injected.twbXml).toContain("filter-group='");
    expect(injected.twbXml).toContain(
      "function='level-members' level='[none:Region:nk]' user:ui-enumeration='all'",
    );
    // The injected worksheet gained the Region column-instance decl.
    expect(injected.twbXml).toContain("name='[none:Region:nk]'");
    // Still well-formed.
    expect(validateTwbXml(injected.twbXml).valid).toBe(true);
  });

  it("co-declares a DERIVED filter field's source column in each worksheet", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const applied = applyWorksheets(
      twbXml,
      [sheet("Sales by Category", "bar")],
      lock,
      fields,
      { onCollision: "create_new_version" },
    );
    // A derived dimension (bin/group/calc) that depends on a real source column
    // that is NOT otherwise used on the sheet.
    const derived: FieldInfo = {
      name: "Sales Band",
      caption: "Sales Band",
      dataType: "string",
      role: "dimension",
      isCalculated: false,
      aggregated: false,
      datasourceId: lock.datasourceId,
      dependsOn: ["Segment"],
    };
    const spec = DashboardSpecSchema.parse({
      name: "FilteredDerived",
      rows: [{ sheets: [{ worksheet: applied.added[0]! }] }],
      filters: { fields: ["Sales Band"] },
    });
    const compiled = compileDashboard(
      spec,
      lock,
      [...fields, derived],
      applied.added,
    );
    // resolveFilterField captured the source column decl.
    expect(compiled.filterFields[0]!.sourceColumnDecls.join("")).toContain(
      "name='[Segment]'",
    );

    const injected = injectApplyToAllFilters(
      applied.twbXml,
      lock,
      compiled.filterFields,
    );
    // The worksheet's deps now include the derived field's SOURCE column, so
    // Tableau can resolve the filtered field ("... does not exist" fix).
    expect(injected.twbXml).toContain("name='[Sales Band]'");
    expect(injected.twbXml).toContain("name='[Segment]'");
    expect(validateTwbXml(injected.twbXml).valid).toBe(true);
  });

  it("keeps all datasource-dependencies before filters on a parameter-driven Top-N sheet", async () => {
    // A Top-N sheet driven by a PARAMETER emits TWO deps blocks: one for
    // `Parameters` and one for the real datasource. Injecting apply-to-all
    // filters must not slip a filter between them (Tableau's content model
    // requires every `datasource-dependencies` to precede any `<filter>`).
    const { twbXml } = await openTwbx(SAMPLE);
    const topN: WorksheetSpec = {
      name: "Top Categories",
      datasourceName: lock.datasourceName,
      chartType: "bar",
      columns: [{ name: "Category" }],
      rows: [{ name: "Sales", aggregation: "sum" }],
      marks: [],
      calculations: [],
      parameters: [
        { name: "Top N", dataType: "integer", domain: "all", currentValue: "5" },
      ],
      filters: [
        {
          field: "Category",
          topN: {
            field: "Sales",
            n: 5,
            byMeasure: "Sales",
            measureAggregation: "sum",
            direction: "top",
            nParameter: "Top N",
          },
        },
      ],
    };
    const applied = applyWorksheets(twbXml, [topN], lock, fields, {
      onCollision: "create_new_version",
    });
    expect(applied.errors).toHaveLength(0);
    const wsName = applied.added[0]!;

    const spec = DashboardSpecSchema.parse({
      name: "TopNDash",
      rows: [{ sheets: [{ worksheet: wsName }] }],
      filters: { fields: ["Region", "Segment"] },
    });
    const compiled = compileDashboard(spec, lock, fields, applied.added);
    const injected = injectApplyToAllFilters(
      applied.twbXml,
      lock,
      compiled.filterFields,
    );

    // Within the sheet's top-level <view>, the LAST datasource-dependencies must
    // still come before the FIRST filter.
    const wsBlock = new RegExp(
      `<worksheet name='${wsName}'>[\\s\\S]*?</worksheet>`,
    ).exec(injected.twbXml)![0];
    const view = /<view>([\s\S]*?)<\/view>/.exec(wsBlock)![1]!;
    const firstFilter = view.indexOf("<filter");
    const lastDeps = view.lastIndexOf("<datasource-dependencies");
    expect(firstFilter).toBeGreaterThan(-1);
    expect(lastDeps).toBeGreaterThan(-1);
    expect(lastDeps).toBeLessThan(firstFilter);
    expect(validateTwbXml(injected.twbXml).valid).toBe(true);
  });
});

describe("eval: end-to-end dashboard build", () => {
  it("builds 2 sheets + 1 dashboard into a validated, well-formed TWBX", async () => {
    const specs: WorksheetSpec[] = [
      sheet("Sales by Category DB", "bar"),
      sheet("Sales by Region DB", "horizontal_bar"),
    ];
    const dashboard = DashboardSpecSchema.parse({
      name: "Executive Overview",
      title: "Executive Overview",
      sizeMode: "automatic",
      rows: [
        {
          sheets: [
            { worksheet: "Sales by Category DB" },
            { worksheet: "Sales by Region DB" },
          ],
        },
      ],
      filters: { fields: ["Region", "Segment"] },
    });

    const result = await buildWorkbook({
      sourceTwbxPath: SAMPLE,
      specs,
      lock,
      fields,
      dashboards: [dashboard],
      collision: "create_new_version",
      outputName: "DashboardEval_generated",
    });

    expect(result.success).toBe(true);
    expect(result.validationPassed).toBe(true);
    expect(result.dashboardsAdded).toContain("Executive Overview");
    expect(result.datasourcePreserved).toBe(true);
    expect(result.outputPath).toBeTruthy();

    // Open the packaged TWBX and confirm the dashboard + apply-to-all filters.
    const opened = await openTwbx(result.outputPath!);
    expect(validateTwbXml(opened.twbXml).valid).toBe(true);
    // Our generated dashboard uses the plain, universally-accepted opening tag.
    expect(opened.twbXml).toContain("<dashboard name='Executive Overview'>");
    expect(opened.twbXml).toContain("<window class='dashboard' name='Executive Overview'>");
    // Both new worksheets received the apply-to-all Region/Segment filters.
    expect(opened.twbXml).toContain("context='true'");
    expect(opened.twbXml).toContain("[none:Region:nk]");
    expect(opened.twbXml).toContain("[none:Segment:nk]");
  });

  it("builds MULTIPLE charts AND a dashboard in one pass (the full-dashboard flow)", async () => {
    // Mirrors what createDashboard does: build several worksheets first, then the
    // dashboard that references them - all in a single compile.
    const specs: WorksheetSpec[] = [
      {
        name: "KPI One Pass",
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
      },
      sheet("Bar One Pass", "bar"),
      { ...sheet("HBar One Pass", "horizontal_bar"), rows: [{ name: "Region" }], columns: [{ name: "Sales", aggregation: "sum" }] },
    ];
    const dashboard = DashboardSpecSchema.parse({
      name: "One Pass Board",
      title: "Superstore Analysis",
      rows: [
        { sheets: [{ worksheet: "KPI One Pass" }] },
        { sheets: [{ worksheet: "Bar One Pass" }, { worksheet: "HBar One Pass" }] },
      ],
      filters: { fields: ["Region", "Segment", "Order Date"] },
    });

    const res = await compileWorkbookToWorking({
      sourceTwbxPath: SAMPLE,
      specs,
      dashboards: [dashboard],
      lock,
      fields,
      collision: "create_new_version",
    });
    expect(res.errors).toHaveLength(0);
    expect(res.added).toEqual(
      expect.arrayContaining(["KPI One Pass", "Bar One Pass", "HBar One Pass"]),
    );
    expect(res.dashboardsAdded).toContain("One Pass Board");

    const { result } = await validateTwbxFile({
      twbxPath: res.workingPath,
      lock,
      fields: res.effectiveFields,
      targetWorksheets: res.added,
    });
    expect(result.valid).toBe(true);

    const opened = await openTwbx(res.workingPath);
    // The date filter field defaults to a YEAR discrete part in the panel.
    expect(opened.twbXml).toContain("[yr:Order Date:ok]");
    expect(opened.twbXml).toContain("mode='checkdropdown'");
    expect(opened.twbXml).toContain("show-apply='true'");
  });
});

describe("eval: modify / redesign a dashboard", () => {
  it("replaces a dashboard by name (add a sheet, switch to fixed size) - stays a single dashboard", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const applied = applyWorksheets(
      twbXml,
      [sheet("Mod A", "bar"), { ...sheet("Mod B", "line"), columns: [{ name: "Order Date", dateDerivation: "month" }] }],
      lock,
      fields,
      { onCollision: "create_new_version" },
    );
    expect(applied.errors).toHaveLength(0);

    const before = existingDashboardNames(applied.twbXml).length;

    // Create the dashboard with a single sheet + automatic sizing.
    const v1 = DashboardSpecSchema.parse({
      name: "Redesign Board",
      sizeMode: "automatic",
      rows: [{ sheets: [{ worksheet: "Mod A" }] }],
      filters: { fields: ["Region"] },
    });
    const created = applyDashboards(applied.twbXml, [v1], lock, applied.effectiveFields);
    expect(created.dashboardsAdded).toContain("Redesign Board");
    expect(existingDashboardNames(created.twbXml)).toContain("Redesign Board");

    // Modify: same name, add a second sheet AND switch to fixed size.
    const v2 = DashboardSpecSchema.parse({
      name: "Redesign Board",
      sizeMode: "fixed",
      width: 1200,
      height: 900,
      rows: [{ sheets: [{ worksheet: "Mod A" }, { worksheet: "Mod B" }] }],
      filters: { fields: ["Region", "Segment"] },
    });
    const modified = applyDashboards(created.twbXml, [v2], lock, applied.effectiveFields);
    expect(modified.dashboardsModified).toContain("Redesign Board");
    expect(modified.dashboardsAdded).not.toContain("Redesign Board");

    // Still exactly one "Redesign Board" (replace, not duplicate).
    const count = existingDashboardNames(modified.twbXml).filter(
      (n) => n === "Redesign Board",
    ).length;
    expect(count).toBe(1);
    // The redesign took effect: fixed sizing + the new sheet zone are present.
    expect(modified.twbXml).toContain("sizing-mode='fixed'");
    expect(modified.twbXml).toContain("name='Mod B'");
    // Dashboard total grew by exactly one vs. the original sample.
    expect(existingDashboardNames(modified.twbXml).length).toBe(before + 1);
    // Still well-formed.
    expect(validateTwbXml(modified.twbXml).valid).toBe(true);
  });
});

describe("eval: dashboard filter actions", () => {
  it("emits a workbook-level filter action and excludes KPI source sheets", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const applied = applyWorksheets(
      twbXml,
      [sheet("Act Bar", "bar"), { ...sheet("Act KPI", "kpi"), rows: [], columns: [], marks: [{ encodings: [{ shelf: "label", field: { name: "Sales", aggregation: "sum" } }] }] }],
      lock,
      fields,
      { onCollision: "create_new_version" },
    );
    expect(applied.errors).toHaveLength(0);

    const spec = DashboardSpecSchema.parse({
      name: "Action Board",
      rows: [{ sheets: [{ worksheet: "Act Bar" }, { worksheet: "Act KPI" }] }],
      actions: [{ type: "filter", runOn: "select" }],
    });
    const res = applyDashboards(applied.twbXml, [spec], lock, applied.effectiveFields);
    expect(res.errors).toHaveLength(0);
    expect(res.twbXml).toContain("<action caption='Filter on Action Board'");
    expect(res.twbXml).toContain("<command command='tsc:tsl-filter'>");
    expect(res.twbXml).toContain("<param name='special-fields' value='all' />");
    expect(res.twbXml).toContain("<param name='target' value='Action Board' />");
    // KPI sheet is excluded as a filter source by default.
    expect(res.twbXml).toContain("<exclude-sheet name='Act KPI' />");
    expect(res.twbXml).not.toContain("<exclude-sheet name='Act Bar' />");
    expect(validateTwbXml(res.twbXml).valid).toBe(true);
  });

  it("does not duplicate actions when a dashboard is modified", async () => {
    const { twbXml } = await openTwbx(SAMPLE);
    const applied = applyWorksheets(twbXml, [sheet("Dup A", "bar")], lock, fields, {
      onCollision: "create_new_version",
    });
    const spec = DashboardSpecSchema.parse({
      name: "Dup Action Board",
      rows: [{ sheets: [{ worksheet: "Dup A" }] }],
      actions: [{ type: "filter" }],
    });
    const first = applyDashboards(applied.twbXml, [spec], lock, applied.effectiveFields);
    const second = applyDashboards(first.twbXml, [spec], lock, applied.effectiveFields);
    const count = (second.twbXml.match(/caption='Filter on Dup Action Board'/g) ?? [])
      .length;
    expect(count).toBe(1);
  });
});
