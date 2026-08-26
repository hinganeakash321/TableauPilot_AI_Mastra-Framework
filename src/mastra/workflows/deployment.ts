/**
 * Tableau Cloud deployment workflow with human-in-the-loop (spec sections 15,
 * 63-69).
 *
 * authenticate (suspend for credentials) -> resolve project -> deployment
 * preview -> HUMAN APPROVAL (suspend) -> publish -> verify -> URL.
 *
 * Security (spec 64, 70): PAT credentials are supplied at RESUME time and used
 * immediately for sign-in; they are never placed in the workflow input or output
 * state. Only an opaque `sessionId` handle flows between steps - the live token
 * stays in this module's in-memory store.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import {
  TableauCloudService,
  type CloudSession,
} from "../../tableau/cloud/tableauCloudService.js";
import { resolveWorkbookPath } from "../../tableau/paths.js";
import {
  DeploymentSpecSchema,
  DeploymentResultSchema,
} from "../schemas/index.js";

/** Live sessions keyed by opaque handle. Tokens never enter workflow state. */
const sessions = new Map<string, CloudSession>();

let serviceFactory: () => TableauCloudService = () => new TableauCloudService();
/** Allows tests to inject a mocked Tableau Cloud service (spec 79). */
export function setDeploymentServiceFactory(
  factory: () => TableauCloudService,
): void {
  serviceFactory = factory;
}

const inputSchema = z.object({
  twbxPath: z.string(),
  workbookName: z.string(),
  serverUrl: z.string().url(),
  siteContentUrl: z.string(),
  projectNameOrPath: z.string(),
});

const previewOutput = DeploymentSpecSchema.extend({ sessionId: z.string() });

const authenticateAndPreview = createStep({
  id: "authenticateAndPreview",
  description:
    "Suspend for PAT credentials, sign in, resolve the project, and build a " +
    "deployment preview. Credentials are used transiently and never stored.",
  inputSchema,
  outputSchema: previewOutput,
  suspendSchema: z.object({
    reason: z.literal("credentials_required"),
    serverUrl: z.string(),
    siteContentUrl: z.string(),
    workbookName: z.string(),
    projectNameOrPath: z.string(),
  }),
  resumeSchema: z.object({
    patName: z.string().min(1),
    patSecret: z.string().min(1),
  }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      return suspend({
        reason: "credentials_required",
        serverUrl: inputData.serverUrl,
        siteContentUrl: inputData.siteContentUrl,
        workbookName: inputData.workbookName,
        projectNameOrPath: inputData.projectNameOrPath,
      });
    }

    const service = serviceFactory();
    const session = await service.signIn({
      serverUrl: inputData.serverUrl,
      siteContentUrl: inputData.siteContentUrl,
      patName: resumeData.patName,
      patSecret: resumeData.patSecret,
    });
    const sessionId = randomUUID();
    sessions.set(sessionId, session);

    const project = await service.resolveProject(
      session,
      inputData.projectNameOrPath,
    );
    const exists = await service.workbookExists(
      session,
      project.name,
      inputData.workbookName,
    );

    return {
      sessionId,
      twbxPath: resolveWorkbookPath(inputData.twbxPath),
      workbookName: inputData.workbookName,
      projectId: project.id,
      projectName: project.name,
      siteContentUrl: session.siteContentUrl,
      serverUrl: session.serverUrl,
      publishMode: (exists ? "overwrite" : "create_new") as
        | "overwrite"
        | "create_new",
    };
  },
});

const approveAndPublish = createStep({
  id: "approveAndPublish",
  description:
    "Show the deployment preview, suspend for approval, then publish and verify.",
  inputSchema: previewOutput,
  outputSchema: DeploymentResultSchema,
  suspendSchema: z.object({
    reason: z.literal("approval_required"),
    workbookName: z.string(),
    projectName: z.string(),
    serverUrl: z.string(),
    site: z.string(),
    publishMode: z.string(),
    overwriteWarning: z.boolean(),
  }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      return suspend({
        reason: "approval_required",
        workbookName: inputData.workbookName,
        projectName: inputData.projectName,
        serverUrl: inputData.serverUrl,
        site: inputData.siteContentUrl,
        publishMode: inputData.publishMode,
        overwriteWarning: inputData.publishMode === "overwrite",
      });
    }

    const session = sessions.get(inputData.sessionId);
    if (!session) {
      return {
        success: false,
        warnings: [],
        errors: ["Session expired before publish. Re-run the deployment."],
      };
    }

    if (!resumeData.approved) {
      sessions.delete(inputData.sessionId);
      return {
        success: false,
        warnings: ["Deployment cancelled by user before publishing."],
        errors: [],
      };
    }

    const service = serviceFactory();
    try {
      const published = await service.publishWorkbook(session, {
        filePath: inputData.twbxPath,
        workbookName: inputData.workbookName,
        projectId: inputData.projectId,
        overwrite: inputData.publishMode === "overwrite",
      });
      const verified = await service.verifyWorkbook(session, published.id);
      return {
        success: true,
        workbookId: verified.id,
        workbookName: verified.name || published.name,
        projectName: inputData.projectName,
        projectId: inputData.projectId,
        site: inputData.siteContentUrl,
        webpageUrl: verified.webpageUrl ?? published.webpageUrl,
        publishMode: inputData.publishMode,
        warnings: [],
        errors: [],
      };
    } catch (err) {
      return {
        success: false,
        warnings: [],
        errors: [err instanceof Error ? err.message : "Deployment failed."],
      };
    } finally {
      sessions.delete(inputData.sessionId);
    }
  },
});

export const tableauCloudDeploymentWorkflow = createWorkflow({
  id: "tableauCloudDeploymentWorkflow",
  description:
    "Deploy a user-provided TWBX to Tableau Cloud with credential and approval " +
    "gates. Publishing is never automatic.",
  inputSchema,
  outputSchema: DeploymentResultSchema,
})
  .then(authenticateAndPreview)
  .then(approveAndPublish)
  .commit();
