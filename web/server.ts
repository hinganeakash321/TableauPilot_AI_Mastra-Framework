/**
 * TableauPilot AI - Node.js web UI server.
 *
 * A lightweight Express front-end that replaces Mastra Studio for end users:
 *   - Upload a `.twbx` at the start (binary is saved to the uploads inbox, never
 *     pasted into chat and never sent to the LLM).
 *   - Chat with the TableauPilot agent (runs in-process; full tools/memory).
 *   - Download the rebuilt `.twbx` after the agent adds the requested charts.
 *
 * `dotenv/config` MUST load before importing the Mastra instance so the model
 * layer (gateway URL, key helper, CA cert) sees the environment.
 */

import "dotenv/config";

import { existsSync } from "node:fs";
import { readFile, writeFile, stat, readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import multer from "multer";

import { mastra } from "../src/mastra/index.js";
import { memory } from "../src/mastra/memory/memory.js";
import { inspectWorkbookFile } from "../src/tableau/inspect.js";
import {
  TableauCloudService,
  TableauCloudError,
  type CloudSession,
} from "../src/tableau/cloud/tableauCloudService.js";
import {
  ensureUploadsDir,
  listWorkbookFiles,
  resolveWorkbookPath,
  UPLOADS_DIR,
  type WorkbookFile,
} from "../src/tableau/paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const WORKSPACE_ROOT = process.env.WORKSPACE_PATH ?? "./workspace";
const PROJECT_ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.WEB_PORT ?? 5173);
const AGENT_ID = "tableauPilotAgent";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

/** Keeps a safe base filename and guarantees a .twbx/.twb extension. */
function safeName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  return base || "workbook.twbx";
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

/**
 * Built workbooks are EPHEMERAL: they are never retained on disk. After each
 * build we read the freshly generated `.twbx` into memory, keyed by the caller's
 * session, then delete every on-disk build artifact. The download/deploy routes
 * serve straight from this in-memory store, so a build only exists for the
 * current instance (and vanishes on reset or server restart).
 */
type BuiltArtifact = { name: string; bytes: Buffer; sizeBytes: number; modified: string };
const builtBySession = new Map<string, BuiltArtifact>();

/** Deletes all generated `.twbx` files from the workspace working/output dirs. */
async function purgeWorkspaceArtifacts(): Promise<void> {
  const dirs = [
    join(PROJECT_ROOT, WORKSPACE_ROOT, "output"),
    join(WORKSPACE_ROOT, "output"),
    join(PROJECT_ROOT, WORKSPACE_ROOT, "working"),
    join(WORKSPACE_ROOT, "working"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.twbx?$/i.test(n)) continue;
      try {
        await rm(join(dir, n), { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Captures a workbook built during this request into the in-memory session store,
 * then purges all on-disk build artifacts. Returns null when nothing new was built.
 */
async function captureBuild(session: string, startTs: number): Promise<BuiltArtifact | null> {
  const built = await latestBuilt();
  if (!built || new Date(built.modified).getTime() < startTs) return null;
  const bytes = await readFile(built.path);
  const artifact: BuiltArtifact = {
    name: built.name,
    bytes,
    sizeBytes: bytes.length,
    modified: built.modified,
  };
  builtBySession.set(session, artifact);
  await purgeWorkspaceArtifacts();
  return artifact;
}

/** Health check. */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, model: process.env.LLM_MODEL, uploadsDir: UPLOADS_DIR });
});

/** List available workbooks (uploads inbox + workspace). */
app.get("/api/workbooks", async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, workbooks: await listWorkbookFiles() });
  } catch (err) {
    res.status(500).json({ ok: false, error: errMsg(err) });
  }
});

/**
 * Deterministically inspect a workbook (no LLM): datasources, field/worksheet
 * counts, and an auto-lock suggestion when there is exactly one datasource.
 * Powers Page 1 ("Upload & check datasource").
 */
app.get("/api/inspect", async (req: Request, res: Response) => {
  const name = String(req.query.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name is required" });
  try {
    const r = await inspectWorkbookFile(name);
    const lock =
      r.datasources.length === 1
        ? {
            datasourceId: r.datasources[0]!.id,
            datasourceName: r.datasources[0]!.caption ?? r.datasources[0]!.name,
            connectionType: r.datasources[0]!.connectionType,
            connectionMode: r.datasources[0]!.connectionMode,
            locked: true as const,
          }
        : null;
    res.json({
      ok: true,
      workbookName: r.workbookName,
      tableauVersion: r.tableauVersion,
      counts: r.counts,
      datasources: r.datasources.map((d) => ({
        id: d.id,
        name: d.caption ?? d.name,
        connectionType: d.connectionType,
        connectionMode: d.connectionMode,
        hasExtract: d.hasExtract,
        connections: d.connections.map((c) => ({
          connectionClass: c.connectionClass,
          filename: c.filename,
          server: c.server,
        })),
        tables: d.tables,
      })),
      worksheets: r.worksheets.map((w) => w.name),
      lock,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: errMsg(err) });
  }
});

/** Upload a .twbx into the uploads inbox. */
app.post(
  "/api/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ ok: false, error: "No file provided (field 'file')." });
      }
      const name = safeName(file.originalname || "workbook.twbx");
      if (!/\.twbx?$/i.test(name)) {
        return res.status(400).json({ ok: false, error: "Only .twbx/.twb files are accepted." });
      }
      const dir = await ensureUploadsDir();
      const dest = join(dir, name);
      await writeFile(dest, file.buffer);
      res.json({ ok: true, name, sizeBytes: file.buffer.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: errMsg(err) });
    }
  },
);

/**
 * Chat with the agent. Memory is keyed by the caller's `sessionId` so the locked
 * datasource and workbook context persist across turns. Approval-gated tools
 * (e.g. packaging) auto-resume so the build completes in one request.
 */
app.post("/api/chat", async (req: Request, res: Response) => {
  const { message, sessionId } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ ok: false, error: "message is required" });
  }
  const session = typeof sessionId === "string" && sessionId ? sessionId : "web-default";
  try {
    // Anchor a "freshly built" window to this request so we never surface a
    // stale artifact from a previous session/turn as if it were just created.
    const startTs = Date.now() - 2000;
    const agent = mastra.getAgent(AGENT_ID);
    const result = await agent.generate(message, {
      memory: { thread: session, resource: session },
      autoResumeSuspendedTools: true,
      maxSteps: 40,
    });
    // Pull any freshly built workbook into memory and delete it from disk, so
    // nothing is retained in a folder - it only lives for this instance.
    const built = await captureBuild(session, startTs);
    res.json({
      ok: true,
      text: (result as { text?: string }).text ?? "",
      output: built ? { name: built.name, sizeBytes: built.sizeBytes, modified: built.modified } : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: errMsg(err) });
  }
});

/**
 * Start a fresh chat: wipe the agent's memory (conversation history + working
 * memory) for the given session so NOTHING from the previous chat - including the
 * previously locked workbook/datasource - carries over. The client pairs this with
 * a brand-new session id and forces a fresh upload, so the next build uses only the
 * newly uploaded workbook.
 */
app.post("/api/reset", async (req: Request, res: Response) => {
  const { sessionId } = req.body ?? {};
  const session = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "";
  if (!session) return res.json({ ok: true, cleared: false });
  builtBySession.delete(session);
  try {
    await memory.deleteThread(session);
    res.json({ ok: true, cleared: true });
  } catch {
    // Thread may not exist yet (no messages sent) - that's fine, still a clean start.
    res.json({ ok: true, cleared: false });
  }
});

/** Info on the current in-memory build for this session (nothing on disk). */
app.get("/api/output", (req: Request, res: Response) => {
  const session = String(req.query.sessionId ?? "").trim();
  const b = session ? builtBySession.get(session) : undefined;
  res.json({
    ok: true,
    output: b ? { name: b.name, sizeBytes: b.sizeBytes, modified: b.modified } : null,
  });
});

/**
 * Download the current build. Builds live only in memory (per session), so we
 * serve straight from the in-memory buffer. A `name` fallback still allows
 * downloading an uploaded source workbook if ever requested.
 */
app.get("/api/download", async (req: Request, res: Response) => {
  const session = String(req.query.sessionId ?? "").trim();
  const name = String(req.query.name ?? "").trim();
  const artifact = session ? builtBySession.get(session) : undefined;
  try {
    if (artifact && (!name || name === artifact.name)) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${artifact.name}"`);
      return res.send(artifact.bytes);
    }
    if (name) {
      const path = resolveWorkbookPath(name);
      if (existsSync(path)) {
        const buf = await readFile(path);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${basename(path)}"`);
        return res.send(buf);
      }
    }
    return res.status(404).json({ ok: false, error: "No build available to download." });
  } catch (err) {
    res.status(404).json({ ok: false, error: errMsg(err) });
  }
});

/**
 * Publish a built workbook to Tableau Cloud (Page 3). Credentials (PAT) are used
 * transiently for sign-in and are NEVER logged, stored, or returned. On success
 * returns the published workbook URL.
 */
app.post("/api/deploy", async (req: Request, res: Response) => {
  const {
    name,
    sessionId,
    serverUrl,
    siteContentUrl,
    patName,
    patSecret,
    projectName,
    workbookName,
    overwrite,
  } = req.body ?? {};

  const missing = ["serverUrl", "patName", "patSecret", "projectName"].filter(
    (k) => !String((req.body ?? {})[k] ?? "").trim(),
  );
  if (missing.length) {
    return res
      .status(400)
      .json({ ok: false, error: `Missing required fields: ${missing.join(", ")}` });
  }

  // Prefer the current in-memory build for this session (written to a transient
  // temp file only for the duration of the publish, then deleted). Fall back to
  // an uploaded workbook on disk when an explicit name is given.
  const session = typeof sessionId === "string" ? sessionId.trim() : "";
  const artifact = session ? builtBySession.get(session) : undefined;
  let filePath: string;
  let tempDir: string | null = null;
  try {
    if (artifact && (!name || String(name) === artifact.name)) {
      tempDir = await mkdtemp(join(tmpdir(), "tp-deploy-"));
      filePath = join(tempDir, artifact.name);
      await writeFile(filePath, artifact.bytes);
    } else {
      filePath = name ? resolveWorkbookPath(String(name)) : "";
      if (!filePath || !existsSync(filePath)) {
        return res.status(400).json({ ok: false, error: "No built workbook to deploy. Build one first." });
      }
    }
  } catch (err) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return res.status(400).json({ ok: false, error: errMsg(err) });
  }

  const service = new TableauCloudService();
  let cloudSession: CloudSession | null = null;
  try {
    cloudSession = await service.signIn({
      serverUrl: String(serverUrl),
      siteContentUrl: String(siteContentUrl ?? ""),
      patName: String(patName),
      patSecret: String(patSecret),
    });
    const project = await service.resolveProject(cloudSession, String(projectName));
    const wbName = String(workbookName ?? "").trim() || basename(filePath).replace(/\.twbx?$/i, "");
    const exists = await service.workbookExists(cloudSession, project.name, wbName);
    const doOverwrite = Boolean(overwrite);
    if (exists && !doOverwrite) {
      return res.status(409).json({
        ok: false,
        error: `A workbook named "${wbName}" already exists in "${project.name}". Enable "Overwrite" to replace it.`,
      });
    }
    const published = await service.publishWorkbook(cloudSession, {
      filePath,
      workbookName: wbName,
      projectId: project.id,
      overwrite: doOverwrite,
    });
    const verified = await service.verifyWorkbook(cloudSession, published.id).catch(() => published);
    res.json({
      ok: true,
      workbook: {
        name: verified.name || wbName,
        url: verified.webpageUrl || published.webpageUrl || null,
        project: project.path ?? project.name,
        overwritten: exists && doOverwrite,
      },
    });
  } catch (err) {
    const code = err instanceof TableauCloudError ? err.code : "DEPLOYMENT_FAILED";
    res.status(502).json({ ok: false, code, error: errMsg(err) });
  } finally {
    if (cloudSession) await service.signOut(cloudSession).catch(() => {});
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `\n  TableauPilot AI web UI  →  http://localhost:${PORT}\n` +
      `  Model: ${process.env.LLM_MODEL}\n` +
      `  Uploads: ${UPLOADS_DIR}\n`,
  );
});

/** Finds the most recently modified built workbook (output dir, then working). */
async function latestBuilt(): Promise<WorkbookFile | null> {
  const dirs = [
    join(PROJECT_ROOT, WORKSPACE_ROOT, "output"),
    join(WORKSPACE_ROOT, "output"),
    join(PROJECT_ROOT, WORKSPACE_ROOT, "working"),
    join(WORKSPACE_ROOT, "working"),
  ];
  let best: WorkbookFile | null = null;
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.twbx?$/i.test(n)) continue;
      const full = resolve(join(dir, n));
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        const wb: WorkbookFile = {
          name: n,
          path: full,
          sizeBytes: s.size,
          modified: s.mtime.toISOString(),
          location: dir,
        };
        if (!best || wb.modified > best.modified) best = wb;
      } catch {
        // ignore
      }
    }
  }
  return best;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
