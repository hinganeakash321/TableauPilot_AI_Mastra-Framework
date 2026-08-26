import { describe, it, expect, beforeEach } from "vitest";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import {
  tableauCloudDeploymentWorkflow,
  setDeploymentServiceFactory,
} from "../../src/mastra/workflows/index.js";
import { TableauCloudService } from "../../src/tableau/cloud/tableauCloudService.js";

const SERVER = "https://10ax.online.tableau.com";
const SAMPLE = "./sample_workbook.twbx";

function mockFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/auth/signin")) {
      return json({ credentials: { token: "T", site: { id: "s1", contentUrl: "acme" } } });
    }
    if (url.includes("/projects")) {
      return json({
        pagination: { totalAvailable: "1" },
        projects: { project: [{ id: "p1", name: "Finance" }] },
      });
    }
    if (url.match(/\/workbooks\?filter=/)) return json({ workbooks: {} });
    if (url.match(/\/workbooks\?overwrite=/) && method === "POST") {
      return json({
        workbook: { id: "wb-9", name: "Sales", webpageUrl: `${SERVER}/#/workbooks/wb-9`, project: { id: "p1" } },
      });
    }
    if (url.match(/\/workbooks\/wb-9$/)) {
      return json({
        workbook: { id: "wb-9", name: "Sales", webpageUrl: `${SERVER}/#/workbooks/wb-9`, project: { id: "p1" } },
      });
    }
    return new Response("nf", { status: 404 });
  }) as typeof globalThis.fetch;
}

function makeMastra() {
  return new Mastra({
    storage: new LibSQLStore({ id: "test", url: ":memory:" }),
    workflows: { tableauCloudDeploymentWorkflow },
    logger: false,
  });
}

describe("tableauCloudDeploymentWorkflow (HITL, mocked)", () => {
  beforeEach(() => {
    setDeploymentServiceFactory(
      () => new TableauCloudService({ fetchImpl: mockFetch(), apiVersion: "3.24" }),
    );
  });

  it("suspends for credentials, then approval, then publishes", async () => {
    const mastra = makeMastra();
    const run = await mastra.getWorkflow("tableauCloudDeploymentWorkflow").createRun();
    const started = await run.start({
      inputData: {
        twbxPath: SAMPLE,
        workbookName: "Sales",
        serverUrl: SERVER,
        siteContentUrl: "acme",
        projectNameOrPath: "Finance",
      },
    });

    expect(started.status).toBe("suspended");
    if (started.status === "suspended") {
      expect(started.suspendPayload.authenticateAndPreview.reason).toBe(
        "credentials_required",
      );
    }

    const afterCreds = await run.resume({
      step: "authenticateAndPreview",
      resumeData: { patName: "pat", patSecret: "shh" },
    });
    expect(afterCreds.status).toBe("suspended");
    if (afterCreds.status === "suspended") {
      const payload = afterCreds.suspendPayload.approveAndPublish;
      expect(payload.reason).toBe("approval_required");
      expect(payload.publishMode).toBe("create_new");
    }

    const published = await run.resume({
      step: "approveAndPublish",
      resumeData: { approved: true },
    });
    expect(published.status).toBe("success");
    if (published.status === "success") {
      expect(published.result.success).toBe(true);
      expect(published.result.workbookId).toBe("wb-9");
      expect(published.result.webpageUrl).toContain("wb-9");
    }
  });

  it("does not publish when approval is denied", async () => {
    const mastra = makeMastra();
    const run = await mastra.getWorkflow("tableauCloudDeploymentWorkflow").createRun();
    await run.start({
      inputData: {
        twbxPath: SAMPLE,
        workbookName: "Sales",
        serverUrl: SERVER,
        siteContentUrl: "acme",
        projectNameOrPath: "Finance",
      },
    });
    await run.resume({
      step: "authenticateAndPreview",
      resumeData: { patName: "pat", patSecret: "shh" },
    });
    const denied = await run.resume({
      step: "approveAndPublish",
      resumeData: { approved: false },
    });
    expect(denied.status).toBe("success");
    if (denied.status === "success") {
      expect(denied.result.success).toBe(false);
      expect(denied.result.workbookId).toBeUndefined();
    }
  });
});
