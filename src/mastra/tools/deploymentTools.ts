/**
 * Tableau Cloud deployment tools (spec section 19 - DEPLOYMENT, 63-69).
 *
 * Security: PAT secrets and the session token NEVER leave this module or appear
 * in tool outputs, memory, or traces (spec 64, 70). Sign-in returns an opaque
 * `sessionId` handle; the real token is held server-side only. Publishing is
 * high-impact and requires approval (spec 18, 67).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import {
  TableauCloudService,
  type CloudSession,
} from "../../tableau/cloud/tableauCloudService.js";
import {
  ProjectInfoSchema,
  DeploymentResultSchema,
} from "../schemas/index.js";
import { runTool, toolResult } from "./_shared.js";

/** In-memory session store. Tokens live here only, never in outputs/memory. */
const sessions = new Map<string, CloudSession>();

function getSession(sessionId: string): CloudSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Invalid or expired sessionId. Sign in again.");
  return s;
}

/** Allows tests / workflows to inject a mocked service. */
let serviceFactory: () => TableauCloudService = () => new TableauCloudService();
export function setTableauCloudServiceFactory(factory: () => TableauCloudService) {
  serviceFactory = factory;
}

export const connectTableauCloud = createTool({
  id: "connectTableauCloud",
  description:
    "Sign in to Tableau Cloud with a Personal Access Token and return an opaque " +
    "sessionId. The PAT secret and auth token are never stored in memory/traces.",
  inputSchema: z.object({
    serverUrl: z.string().url(),
    siteContentUrl: z.string(),
    patName: z.string(),
    patSecret: z.string(),
  }),
  outputSchema: toolResult(
    z.object({
      sessionId: z.string(),
      siteContentUrl: z.string(),
      apiVersion: z.string(),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const service = serviceFactory();
      const session = await service.signIn(inputData);
      const sessionId = randomUUID();
      sessions.set(sessionId, session);
      return {
        sessionId,
        siteContentUrl: session.siteContentUrl,
        apiVersion: session.apiVersion,
      };
    }, "DEPLOYMENT_AUTH_FAILED"),
});

export const listProjects = createTool({
  id: "listProjects",
  description: "List real projects on the Tableau Cloud site for a session.",
  inputSchema: z.object({ sessionId: z.string() }),
  outputSchema: toolResult(z.object({ projects: z.array(ProjectInfoSchema) })),
  execute: async (inputData) =>
    runTool(async () => {
      const service = serviceFactory();
      const projects = await service.listProjects(getSession(inputData.sessionId));
      return { projects };
    }, "DEPLOYMENT_FAILED"),
});

export const resolveProject = createTool({
  id: "resolveProject",
  description: "Resolve a project by id, name, or full path (Parent / Child).",
  inputSchema: z.object({ sessionId: z.string(), nameOrPath: z.string() }),
  outputSchema: toolResult(z.object({ project: ProjectInfoSchema })),
  execute: async (inputData) =>
    runTool(async () => {
      const service = serviceFactory();
      const project = await service.resolveProject(
        getSession(inputData.sessionId),
        inputData.nameOrPath,
      );
      return { project };
    }, "DEPLOYMENT_FAILED"),
});

export const validatePublish = createTool({
  id: "validatePublish",
  description:
    "Check whether a workbook name already exists in the target project so the " +
    "user can be warned before overwriting (spec 68).",
  inputSchema: z.object({
    sessionId: z.string(),
    projectName: z.string(),
    workbookName: z.string(),
  }),
  outputSchema: toolResult(
    z.object({ exists: z.boolean(), publishMode: z.enum(["create_new", "overwrite"]) }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const service = serviceFactory();
      const exists = await service.workbookExists(
        getSession(inputData.sessionId),
        inputData.projectName,
        inputData.workbookName,
      );
      return {
        exists,
        publishMode: exists ? ("overwrite" as const) : ("create_new" as const),
      };
    }, "DEPLOYMENT_FAILED"),
});

export const publishWorkbook = createTool({
  id: "publishWorkbook",
  description:
    "Publish a TWBX to a Tableau Cloud project (high-impact - requires approval). " +
    "Verifies the workbook after publishing and returns its URL (spec 67-69).",
  requireApproval: true,
  inputSchema: z.object({
    sessionId: z.string(),
    twbxPath: z.string(),
    workbookName: z.string(),
    projectId: z.string(),
    projectName: z.string().optional(),
    overwrite: z.boolean().default(false),
  }),
  outputSchema: toolResult(DeploymentResultSchema),
  execute: async (inputData) =>
    runTool(async () => {
      const service = serviceFactory();
      const session = getSession(inputData.sessionId);
      const published = await service.publishWorkbook(session, {
        filePath: inputData.twbxPath,
        workbookName: inputData.workbookName,
        projectId: inputData.projectId,
        overwrite: inputData.overwrite,
      });
      const verified = await service.verifyWorkbook(session, published.id);
      return {
        success: true,
        workbookId: verified.id,
        workbookName: verified.name,
        projectId: inputData.projectId,
        projectName: inputData.projectName,
        site: session.siteContentUrl,
        webpageUrl: verified.webpageUrl,
        publishMode: inputData.overwrite ? ("overwrite" as const) : ("create_new" as const),
        warnings: [],
        errors: [],
      };
    }, "DEPLOYMENT_FAILED"),
});

export const verifyWorkbook = createTool({
  id: "verifyWorkbook",
  description: "Verify a published workbook exists and return its details/URL.",
  inputSchema: z.object({ sessionId: z.string(), workbookId: z.string() }),
  outputSchema: toolResult(
    z.object({
      id: z.string(),
      name: z.string(),
      webpageUrl: z.string().optional(),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const service = serviceFactory();
      const wb = await service.verifyWorkbook(
        getSession(inputData.sessionId),
        inputData.workbookId,
      );
      return { id: wb.id, name: wb.name, webpageUrl: wb.webpageUrl };
    }, "DEPLOYMENT_FAILED"),
});

export const deploymentTools = {
  connectTableauCloud,
  listProjects,
  resolveProject,
  validatePublish,
  publishWorkbook,
  verifyWorkbook,
};
