/**
 * Tableau Cloud REST client (spec sections 63-69).
 *
 * Implemented entirely in TypeScript using the Tableau REST API - no Python /
 * TSC dependency is required for sign-in, project listing, publishing, or
 * verification. `fetch` is injectable so tests can mock the server without any
 * live credentials (spec section 79).
 *
 * Security: PAT secrets are used transiently for sign-in only. They are never
 * logged, stored, or attached to results (spec sections 64, 70).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ProjectInfo } from "../../mastra/schemas/deployment.js";
import { logger } from "../../config/logger.js";

/** Minimal fetch signature used by the client (injectable for tests). */
export type FetchLike = typeof globalThis.fetch;

/** Credentials required to sign in (transient - never persisted). */
export interface SignInInput {
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  patSecret: string;
}

/** An authenticated session. The token is sensitive and never logged. */
export interface CloudSession {
  token: string;
  siteId: string;
  siteContentUrl: string;
  serverUrl: string;
  apiVersion: string;
}

export interface PublishInput {
  filePath: string;
  workbookName: string;
  projectId: string;
  overwrite: boolean;
}

export interface PublishedWorkbook {
  id: string;
  name: string;
  webpageUrl?: string;
  projectId?: string;
}

/** Options for constructing the service. */
export interface TableauCloudServiceOptions {
  fetchImpl?: FetchLike;
  /** REST API version, e.g. `3.24`. Auto-detected via serverinfo if omitted. */
  apiVersion?: string;
}

/** Error carrying a stable code for the deployment flow. */
export class TableauCloudError extends Error {
  constructor(
    public readonly code:
      | "DEPLOYMENT_AUTH_FAILED"
      | "DEPLOYMENT_FAILED",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TableauCloudError";
  }
}

const DEFAULT_API_VERSION = "3.24";

export class TableauCloudService {
  private fetchImpl: FetchLike;
  private apiVersionOverride?: string;

  constructor(options: TableauCloudServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiVersionOverride = options.apiVersion;
  }

  private base(serverUrl: string, apiVersion: string): string {
    return `${serverUrl.replace(/\/+$/, "")}/api/${apiVersion}`;
  }

  /** Detects the REST API version via the unauthenticated serverinfo endpoint. */
  async detectApiVersion(serverUrl: string): Promise<string> {
    if (this.apiVersionOverride) return this.apiVersionOverride;
    try {
      const url = `${serverUrl.replace(/\/+$/, "")}/api/2.4/serverinfo`;
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          serverInfo?: { restApiVersion?: string };
        };
        const v = json.serverInfo?.restApiVersion;
        if (v) return v;
      }
    } catch (err) {
      logger.warn("serverinfo detection failed; using default API version", {
        message: (err as Error).message,
      });
    }
    return DEFAULT_API_VERSION;
  }

  /** Signs in with a Personal Access Token. */
  async signIn(input: SignInInput): Promise<CloudSession> {
    const apiVersion = await this.detectApiVersion(input.serverUrl);
    const url = `${this.base(input.serverUrl, apiVersion)}/auth/signin`;
    const body = {
      credentials: {
        personalAccessTokenName: input.patName,
        personalAccessTokenSecret: input.patSecret,
        site: { contentUrl: input.siteContentUrl },
      },
    };
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new TableauCloudError(
        "DEPLOYMENT_AUTH_FAILED",
        `Tableau Cloud sign-in failed (HTTP ${res.status}). Check server URL, ` +
          `site content URL, and PAT.`,
      );
    }
    const json = (await res.json()) as {
      credentials?: {
        token?: string;
        site?: { id?: string; contentUrl?: string };
      };
    };
    const token = json.credentials?.token;
    const siteId = json.credentials?.site?.id;
    if (!token || !siteId) {
      throw new TableauCloudError(
        "DEPLOYMENT_AUTH_FAILED",
        "Tableau Cloud sign-in response missing token or site id.",
      );
    }
    logger.info("Signed in to Tableau Cloud", {
      site: json.credentials?.site?.contentUrl,
      apiVersion,
    });
    return {
      token,
      siteId,
      siteContentUrl: input.siteContentUrl,
      serverUrl: input.serverUrl,
      apiVersion,
    };
  }

  /** Signs out, invalidating the session token. */
  async signOut(session: CloudSession): Promise<void> {
    const url = `${this.base(session.serverUrl, session.apiVersion)}/auth/signout`;
    try {
      await this.fetchImpl(url, {
        method: "POST",
        headers: this.authHeaders(session),
      });
    } catch {
      // best-effort
    }
  }

  private authHeaders(session: CloudSession): Record<string, string> {
    return {
      "X-Tableau-Auth": session.token,
      Accept: "application/json",
    };
  }

  /** Lists all projects on the site (paginated). */
  async listProjects(session: CloudSession): Promise<ProjectInfo[]> {
    const projects: ProjectInfo[] = [];
    let pageNumber = 1;
    const pageSize = 1000;
    for (;;) {
      const url =
        `${this.base(session.serverUrl, session.apiVersion)}/sites/${session.siteId}` +
        `/projects?pageSize=${pageSize}&pageNumber=${pageNumber}`;
      const res = await this.fetchImpl(url, { headers: this.authHeaders(session) });
      if (!res.ok) {
        throw new TableauCloudError(
          "DEPLOYMENT_FAILED",
          `Failed to list projects (HTTP ${res.status}).`,
        );
      }
      const json = (await res.json()) as {
        pagination?: { totalAvailable?: string };
        projects?: {
          project?:
            | Array<Record<string, string>>
            | Record<string, string>;
        };
      };
      const raw = json.projects?.project;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const p of list) {
        projects.push({
          id: p.id!,
          name: p.name!,
          parentProjectId: p.parentProjectId,
          description: p.description,
        });
      }
      const total = Number(json.pagination?.totalAvailable ?? list.length);
      if (projects.length >= total || list.length === 0) break;
      pageNumber += 1;
    }
    // Compute full paths (Parent / Child) for display.
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const p of projects) {
      const parts = [p.name];
      let parent = p.parentProjectId ? byId.get(p.parentProjectId) : undefined;
      let guard = 0;
      while (parent && guard < 20) {
        parts.unshift(parent.name);
        parent = parent.parentProjectId
          ? byId.get(parent.parentProjectId)
          : undefined;
        guard += 1;
      }
      p.path = parts.join(" / ");
    }
    return projects;
  }

  /** Resolves a project by id, name, or full path. */
  async resolveProject(
    session: CloudSession,
    nameOrPath: string,
  ): Promise<ProjectInfo> {
    const projects = await this.listProjects(session);
    const target = nameOrPath.trim().toLowerCase();
    const match =
      projects.find((p) => p.id === nameOrPath) ??
      projects.find((p) => (p.path ?? "").toLowerCase() === target) ??
      projects.find((p) => p.name.toLowerCase() === target);
    if (!match) {
      throw new TableauCloudError(
        "DEPLOYMENT_FAILED",
        `Project '${nameOrPath}' not found on the site.`,
        { available: projects.map((p) => p.path ?? p.name).slice(0, 20) },
      );
    }
    return match;
  }

  /** Checks whether a workbook with the given name exists in a project. */
  async workbookExists(
    session: CloudSession,
    projectName: string,
    workbookName: string,
  ): Promise<boolean> {
    const url =
      `${this.base(session.serverUrl, session.apiVersion)}/sites/${session.siteId}` +
      `/workbooks?filter=${encodeURIComponent(`name:eq:${workbookName}`)}`;
    const res = await this.fetchImpl(url, { headers: this.authHeaders(session) });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      workbooks?: { workbook?: Array<Record<string, unknown>> | Record<string, unknown> };
    };
    const raw = json.workbooks?.workbook;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.some((w) => {
      const proj = (w.project as { name?: string } | undefined)?.name;
      return proj ? proj === projectName : true;
    });
  }

  /** Publishes a TWBX to a project (single-request multipart). */
  async publishWorkbook(
    session: CloudSession,
    input: PublishInput,
  ): Promise<PublishedWorkbook> {
    const fileBytes = await readFile(input.filePath);
    const fileName = basename(input.filePath);
    const boundary = `boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const requestPayload =
      `<tsRequest>\n` +
      `  <workbook name="${escapeXmlAttr(input.workbookName)}" showTabs="true">\n` +
      `    <project id="${input.projectId}" />\n` +
      `  </workbook>\n` +
      `</tsRequest>`;

    const body = buildMultipart(boundary, requestPayload, fileName, fileBytes);

    const url =
      `${this.base(session.serverUrl, session.apiVersion)}/sites/${session.siteId}` +
      `/workbooks?overwrite=${input.overwrite ? "true" : "false"}`;

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "X-Tableau-Auth": session.token,
        Accept: "application/json",
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const text = await safeText(res);
      throw new TableauCloudError(
        "DEPLOYMENT_FAILED",
        `Publish failed (HTTP ${res.status}).`,
        { response: text.slice(0, 500) },
      );
    }
    const json = (await res.json()) as {
      workbook?: {
        id?: string;
        name?: string;
        webpageUrl?: string;
        project?: { id?: string };
      };
    };
    const wb = json.workbook;
    if (!wb?.id) {
      throw new TableauCloudError(
        "DEPLOYMENT_FAILED",
        "Publish response missing workbook id.",
      );
    }
    return {
      id: wb.id,
      name: wb.name ?? input.workbookName,
      webpageUrl: wb.webpageUrl,
      projectId: wb.project?.id,
    };
  }

  /** Verifies a workbook exists and returns its details. */
  async verifyWorkbook(
    session: CloudSession,
    workbookId: string,
  ): Promise<PublishedWorkbook> {
    const url =
      `${this.base(session.serverUrl, session.apiVersion)}/sites/${session.siteId}` +
      `/workbooks/${workbookId}`;
    const res = await this.fetchImpl(url, { headers: this.authHeaders(session) });
    if (!res.ok) {
      throw new TableauCloudError(
        "DEPLOYMENT_FAILED",
        `Verification failed (HTTP ${res.status}).`,
      );
    }
    const json = (await res.json()) as {
      workbook?: {
        id?: string;
        name?: string;
        webpageUrl?: string;
        project?: { id?: string };
      };
    };
    const wb = json.workbook;
    if (!wb?.id) {
      throw new TableauCloudError(
        "DEPLOYMENT_FAILED",
        "Verification response missing workbook.",
      );
    }
    return {
      id: wb.id,
      name: wb.name ?? "",
      webpageUrl: wb.webpageUrl,
      projectId: wb.project?.id,
    };
  }
}

/** Builds a Tableau multipart/mixed publish body. */
function buildMultipart(
  boundary: string,
  requestPayload: string,
  fileName: string,
  fileBytes: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const preamble =
    `--${boundary}\r\n` +
    `Content-Disposition: name="request_payload"\r\n` +
    `Content-Type: text/xml\r\n\r\n` +
    `${requestPayload}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: name="tableau_workbook"; filename="${fileName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--\r\n`;
  const pre = enc.encode(preamble);
  const post = enc.encode(epilogue);
  const out = new Uint8Array(pre.length + fileBytes.length + post.length);
  out.set(pre, 0);
  out.set(fileBytes, pre.length);
  out.set(post, pre.length + fileBytes.length);
  return out;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
