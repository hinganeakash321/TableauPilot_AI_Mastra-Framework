import { describe, it, expect } from "vitest";
import { TableauCloudService } from "../../src/tableau/cloud/tableauCloudService.js";

const SERVER = "https://10ax.online.tableau.com";
const SAMPLE = "./sample_workbook.twbx";

/** Builds a mocked Tableau REST server (spec section 79 - no live credentials). */
function mockFetch(opts: { workbookExists?: boolean } = {}): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/auth/signin") && method === "POST") {
      return json({
        credentials: { token: "SECRET-TOKEN", site: { id: "site-1", contentUrl: "acme" } },
      });
    }
    if (url.includes("/projects")) {
      return json({
        pagination: { totalAvailable: "2" },
        projects: {
          project: [
            { id: "p1", name: "Finance" },
            { id: "p2", name: "Executive", parentProjectId: "p1" },
          ],
        },
      });
    }
    if (url.match(/\/workbooks\?filter=/)) {
      return json(
        opts.workbookExists
          ? { workbooks: { workbook: [{ id: "old", name: "Sales", project: { name: "Finance" } }] } }
          : { workbooks: {} },
      );
    }
    if (url.match(/\/workbooks\?overwrite=/) && method === "POST") {
      return json({
        workbook: {
          id: "wb-123",
          name: "Sales Analysis",
          webpageUrl: `${SERVER}/#/workbooks/wb-123`,
          project: { id: "p1" },
        },
      });
    }
    if (url.match(/\/workbooks\/wb-123$/)) {
      return json({
        workbook: {
          id: "wb-123",
          name: "Sales Analysis",
          webpageUrl: `${SERVER}/#/workbooks/wb-123`,
          project: { id: "p1" },
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("TableauCloudService (mocked REST)", () => {
  it("signs in and returns a session (token never surfaced in errors)", async () => {
    const svc = new TableauCloudService({ fetchImpl: mockFetch(), apiVersion: "3.24" });
    const session = await svc.signIn({
      serverUrl: SERVER,
      siteContentUrl: "acme",
      patName: "pat",
      patSecret: "shhh",
    });
    expect(session.siteId).toBe("site-1");
    expect(session.token).toBe("SECRET-TOKEN");
  });

  it("resolves a project by full path", async () => {
    const svc = new TableauCloudService({ fetchImpl: mockFetch(), apiVersion: "3.24" });
    const session = await svc.signIn({
      serverUrl: SERVER,
      siteContentUrl: "acme",
      patName: "pat",
      patSecret: "shhh",
    });
    const project = await svc.resolveProject(session, "Finance / Executive");
    expect(project.id).toBe("p2");
  });

  it("detects an existing workbook for overwrite", async () => {
    const svc = new TableauCloudService({
      fetchImpl: mockFetch({ workbookExists: true }),
      apiVersion: "3.24",
    });
    const session = await svc.signIn({
      serverUrl: SERVER,
      siteContentUrl: "acme",
      patName: "pat",
      patSecret: "shhh",
    });
    expect(await svc.workbookExists(session, "Finance", "Sales")).toBe(true);
  });

  it("publishes and verifies a workbook", async () => {
    const svc = new TableauCloudService({ fetchImpl: mockFetch(), apiVersion: "3.24" });
    const session = await svc.signIn({
      serverUrl: SERVER,
      siteContentUrl: "acme",
      patName: "pat",
      patSecret: "shhh",
    });
    const published = await svc.publishWorkbook(session, {
      filePath: SAMPLE,
      workbookName: "Sales Analysis",
      projectId: "p1",
      overwrite: false,
    });
    expect(published.id).toBe("wb-123");
    const verified = await svc.verifyWorkbook(session, published.id);
    expect(verified.webpageUrl).toContain("wb-123");
  });

  it("throws a structured auth error on 401", async () => {
    const failing = (async () =>
      new Response("no", { status: 401 })) as typeof globalThis.fetch;
    const svc = new TableauCloudService({ fetchImpl: failing, apiVersion: "3.24" });
    await expect(
      svc.signIn({ serverUrl: SERVER, siteContentUrl: "acme", patName: "p", patSecret: "s" }),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_AUTH_FAILED" });
  });
});
