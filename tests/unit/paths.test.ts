import { describe, it, expect } from "vitest";
import { resolveWorkbookPath, listWorkbookFiles } from "../../src/tableau/paths.js";

describe("workbook path resolution", () => {
  it("resolves an existing relative path as-is", () => {
    const p = resolveWorkbookPath("./sample_workbook.twbx");
    expect(p).toMatch(/sample_workbook\.twbx$/);
  });

  it("resolves a bare filename found in the project", () => {
    const p = resolveWorkbookPath("sample_workbook");
    expect(p).toMatch(/sample_workbook\.twbx$/);
  });

  it("throws a helpful error for a missing workbook", () => {
    expect(() => resolveWorkbookPath("does_not_exist_xyz.twbx")).toThrow(
      /not found|upload/i,
    );
  });

  it("lists available workbooks with metadata", async () => {
    const files = await listWorkbookFiles();
    expect(Array.isArray(files)).toBe(true);
    const sample = files.find((f) => f.name === "sample_workbook.twbx");
    expect(sample).toBeDefined();
    expect(sample!.sizeBytes).toBeGreaterThan(0);
  });
});
