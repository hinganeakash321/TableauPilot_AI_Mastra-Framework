/**
 * Tableau Cloud deployment schemas (spec sections 63-69).
 *
 * Credentials are represented here for transient input only; they must never be
 * stored in memory, workflow state, logs, or traces (spec sections 64, 70).
 */

import { z } from "zod";

/** Transient Tableau Cloud credentials (never persisted/logged). */
export const TableauCloudCredentialsSchema = z.object({
  serverUrl: z.string().url(),
  siteContentUrl: z.string(),
  patName: z.string().min(1),
  patSecret: z.string().min(1),
});
export type TableauCloudCredentials = z.infer<
  typeof TableauCloudCredentialsSchema
>;

/** A project discovered on the Tableau Cloud site. */
export const ProjectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Full path including parents, e.g. `Finance / Executive`. */
  path: z.string().optional(),
  parentProjectId: z.string().optional(),
  description: z.string().optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

/** Publish mode. */
export const PublishModeSchema = z.enum(["create_new", "overwrite"]);
export type PublishMode = z.infer<typeof PublishModeSchema>;

/** Deployment specification prepared before publishing (preview payload). */
export const DeploymentSpecSchema = z.object({
  twbxPath: z.string(),
  workbookName: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  siteContentUrl: z.string(),
  serverUrl: z.string(),
  publishMode: PublishModeSchema,
});
export type DeploymentSpec = z.infer<typeof DeploymentSpecSchema>;

/** Result of a deployment (spec section 69). */
export const DeploymentResultSchema = z.object({
  success: z.boolean(),
  workbookId: z.string().optional(),
  workbookName: z.string().optional(),
  projectName: z.string().optional(),
  projectId: z.string().optional(),
  site: z.string().optional(),
  webpageUrl: z.string().optional(),
  publishMode: PublishModeSchema.optional(),
  warnings: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
});
export type DeploymentResult = z.infer<typeof DeploymentResultSchema>;
