import { describe, it, expect } from "vitest";
import { inspectWorkbookFile } from "../../src/tableau/inspect.js";

const SAMPLE = "./sample_workbook.twbx";

describe("workbook inspection (real TWBX)", () => {
  it("extracts the single locked datasource and real fields", async () => {
    const info = await inspectWorkbookFile(SAMPLE);

    expect(info.datasources.length).toBe(1);
    const ds = info.datasources[0]!;
    expect(ds.id).toMatch(/^federated\./);

    const fieldNames = info.fields.map((f) => f.name);
    for (const expected of ["Sales", "Region", "Order Date", "Customer Name"]) {
      expect(fieldNames).toContain(expected);
    }
  });

  it("classifies measures and dimensions", async () => {
    const info = await inspectWorkbookFile(SAMPLE);
    const sales = info.fields.find((f) => f.name === "Sales");
    const region = info.fields.find((f) => f.name === "Region");
    expect(sales?.role).toBe("measure");
    expect(region?.role).toBe("dimension");
  });

  it("reports existing worksheets", async () => {
    const info = await inspectWorkbookFile(SAMPLE);
    expect(info.counts.worksheets).toBeGreaterThan(0);
  });
});
