import { describe, it, expect } from "vitest";
import {
  WorksheetSpecSchema,
  WorksheetPlanSchema,
  DatasourceLockSchema,
  TopNSchema,
} from "../../src/mastra/schemas/index.js";

describe("Zod schemas", () => {
  it("applies array defaults on a minimal WorksheetSpec", () => {
    const spec = WorksheetSpecSchema.parse({
      name: "Sales by Region",
      datasourceName: "Sales_Data",
      chartType: "bar",
    });
    expect(spec.rows).toEqual([]);
    expect(spec.columns).toEqual([]);
    expect(spec.marks).toEqual([]);
    expect(spec.filters).toEqual([]);
    expect(spec.calculations).toEqual([]);
  });

  it("rejects an unsupported chart type", () => {
    const res = WorksheetSpecSchema.safeParse({
      name: "X",
      datasourceName: "d",
      chartType: "sankey",
    });
    expect(res.success).toBe(false);
  });

  it("rejects an empty worksheet name", () => {
    const res = WorksheetSpecSchema.safeParse({
      name: "",
      datasourceName: "d",
      chartType: "bar",
    });
    expect(res.success).toBe(false);
  });

  it("requires at least one worksheet in a plan", () => {
    const res = WorksheetPlanSchema.safeParse({
      worksheets: [],
      lockedDatasource: { datasourceName: "d", datasourceId: "id" },
    });
    expect(res.success).toBe(false);
  });

  it("applies Top-N defaults", () => {
    const topN = TopNSchema.parse({ field: "Customer", n: 10, byMeasure: "Sales" });
    expect(topN.direction).toBe("top");
    expect(topN.measureAggregation).toBe("sum");
  });

  it("locks require locked=true literal", () => {
    const ok = DatasourceLockSchema.safeParse({
      workbookPath: "/a.twbx",
      datasourceName: "Sales",
      datasourceId: "federated.1",
      connectionType: "hyper",
      connectionMode: "extract",
      locked: true,
    });
    expect(ok.success).toBe(true);
    const bad = DatasourceLockSchema.safeParse({
      workbookPath: "/a.twbx",
      datasourceName: "Sales",
      datasourceId: "federated.1",
      connectionType: "hyper",
      connectionMode: "extract",
      locked: false,
    });
    expect(bad.success).toBe(false);
  });
});
