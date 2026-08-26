/**
 * Workbook file intake + path resolution.
 *
 * A `.twbx` is a binary ZIP and must NEVER be pasted into the chat. Instead users
 * drop (or upload via the `/upload` endpoint) the file into the uploads inbox, and
 * the agent references it by name. This module resolves a user-supplied name/path
 * to a real file on disk and lists what is available.
 */

import { readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Finds the project root by walking up from the current working directory until a
 * `package.json` is found. The Mastra dev server runs from a bundled sub-directory,
 * so we anchor the uploads inbox to the real project root - that way uploads are
 * visible in the user's file tree and found regardless of the server's CWD.
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();

/** Inbox directory for uploaded/dropped workbooks (override with UPLOADS_PATH). */
export const UPLOADS_DIR = process.env.UPLOADS_PATH
  ? resolve(process.env.UPLOADS_PATH)
  : join(PROJECT_ROOT, "uploads");

const WORKSPACE_ROOT = process.env.WORKSPACE_PATH ?? "./workspace";

/** Directories searched (in order) when resolving a bare filename. */
function searchDirs(): string[] {
  const dirs = [
    UPLOADS_DIR,
    join(PROJECT_ROOT, "uploads"),
    // Workspace dirs, anchored both to the project root and the CWD (writes are
    // CWD-relative), plus the CWD itself.
    join(PROJECT_ROOT, WORKSPACE_ROOT, "original"),
    join(PROJECT_ROOT, WORKSPACE_ROOT, "output"),
    join(PROJECT_ROOT, WORKSPACE_ROOT, "working"),
    join(WORKSPACE_ROOT, "original"),
    join(WORKSPACE_ROOT, "output"),
    join(WORKSPACE_ROOT, "working"),
    PROJECT_ROOT,
    ".",
  ];
  return [...new Set(dirs)];
}

/** Ensures the uploads inbox exists and returns its absolute path. */
export async function ensureUploadsDir(): Promise<string> {
  const dir = resolve(UPLOADS_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface WorkbookFile {
  name: string;
  path: string;
  sizeBytes: number;
  modified: string;
  location: string;
}

/** Lists available `.twbx`/`.twb` files across the intake + workspace dirs. */
export async function listWorkbookFiles(): Promise<WorkbookFile[]> {
  const seen = new Set<string>();
  const out: WorkbookFile[] = [];
  for (const dir of searchDirs()) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.twbx?$/i.test(name)) continue;
      const full = resolve(join(dir, name));
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const s = await stat(full);
        if (!s.isFile()) continue;
        out.push({
          name,
          path: full,
          sizeBytes: s.size,
          modified: s.mtime.toISOString(),
          location: dir,
        });
      } catch {
        // ignore unreadable entries
      }
    }
  }
  // Most recent first - handy when a user just uploaded.
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Resolves a user-supplied workbook reference to an existing file path.
 * Accepts an absolute path, a path relative to the CWD, or a bare filename that
 * lives in the uploads inbox / workspace. Throws a helpful error otherwise.
 */
export function resolveWorkbookPath(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("No workbook path provided.");

  // 1. Absolute or CWD-relative path that already exists.
  const direct = isAbsolute(raw) ? raw : resolve(raw);
  if (existsSync(direct)) return direct;

  // 2. Bare filename located in one of the search dirs (try with/without .twbx).
  const candidates = /\.twbx?$/i.test(raw) ? [raw] : [`${raw}.twbx`, `${raw}.twb`, raw];
  const base = basename(raw);
  const baseCandidates = /\.twbx?$/i.test(base) ? [base] : [`${base}.twbx`, `${base}.twb`, base];
  for (const dir of searchDirs()) {
    for (const cand of new Set([...candidates, ...baseCandidates])) {
      const full = resolve(join(dir, cand));
      if (existsSync(full)) return full;
    }
  }

  throw new Error(
    `Workbook '${input}' not found. Upload it via http://localhost:4111/upload ` +
      `or drop it into '${UPLOADS_DIR}', then reference it by filename.`,
  );
}
