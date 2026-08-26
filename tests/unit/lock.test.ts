import { describe, it, expect } from "vitest";
import { resolveLock } from "../../src/tableau/lock.js";
import type { DatasourceInfo } from "../../src/mastra/schemas/datasource.js";
import type { WorkbookInspectionResult } from "../../src/mastra/schemas/workbook.js";

function ds(id: string, name: string): DatasourceInfo {
  return {
    id,
    name,
    connectionType: "federated",
    connectionMode: "extract",
    connections: [],
    hasExtract: true,
    tables: [],
  };
}

function inspection(datasources: DatasourceInfo[]): WorkbookInspectionResult {
  return { datasources } as WorkbookInspectionResult;
}

describe("datasource lock (single source of truth)", () => {
  it("auto-locks a single datasource", () => {
    const out = resolveLock(inspection([ds("federated.1", "Sales")]), "/a.twbx");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.lock.datasourceId).toBe("federated.1");
      expect(out.lock.locked).toBe(true);
    }
  });

  it("requires a selection when multiple datasources exist", () => {
    const out = resolveLock(
      inspection([ds("federated.1", "Sales"), ds("federated.2", "Customers")]),
      "/a.twbx",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("MULTIPLE_DATASOURCES");
  });

  it("locks the selected datasource by id", () => {
    const out = resolveLock(
      inspection([ds("federated.1", "Sales"), ds("federated.2", "Customers")]),
      "/a.twbx",
      "federated.2",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lock.datasourceId).toBe("federated.2");
  });

  it("errors when the workbook has no datasource (never creates one)", () => {
    const out = resolveLock(inspection([]), "/a.twbx");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("DATASOURCE_NOT_FOUND");
  });

  it("errors when a selected id is not present", () => {
    const out = resolveLock(
      inspection([ds("federated.1", "Sales")]),
      "/a.twbx",
      "nope",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("DATASOURCE_NOT_FOUND");
  });
});
