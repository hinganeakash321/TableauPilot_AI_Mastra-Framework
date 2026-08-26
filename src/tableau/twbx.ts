/**
 * TWBX (Tableau packaged workbook) handling: open, read, and repackage.
 *
 * A TWBX is a ZIP containing exactly one `.twb` (XML) plus resource files under
 * `Data/` (including the `.hyper` extract). This module preserves every non-`.twb`
 * entry byte-for-byte so the locked datasource and extract are never altered
 * (spec sections 36, 60, 61).
 */

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import JSZip from "jszip";
import { resolveWorkbookPath } from "./paths.js";

/** A single non-`.twb` entry preserved from the original archive. */
export interface PreservedEntry {
  path: string;
  /** Raw bytes of the original entry. */
  data: Uint8Array;
}

/** Result of opening a TWBX. */
export interface OpenedTwbx {
  /** Path to the source TWBX. */
  sourcePath: string;
  /** Internal name of the `.twb` entry (e.g. `sample_workbook.twb`). */
  twbEntryName: string;
  /** The `.twb` XML contents. */
  twbXml: string;
  /** All non-`.twb` entries, preserved verbatim. */
  entries: PreservedEntry[];
}

/** Opens a TWBX and returns its `.twb` XML and preserved resource entries. */
export async function openTwbx(source: string): Promise<OpenedTwbx> {
  const sourcePath = resolveWorkbookPath(source);
  const buf = await readFile(sourcePath);
  const zip = await JSZip.loadAsync(buf);

  const twbEntryName = Object.keys(zip.files).find((f) => f.endsWith(".twb"));
  if (!twbEntryName) {
    throw new Error(`TWBX has no .twb entry: ${sourcePath}`);
  }

  const twbXml = await zip.files[twbEntryName]!.async("string");

  const entries: PreservedEntry[] = [];
  for (const [path, file] of Object.entries(zip.files)) {
    if (path === twbEntryName) continue;
    if (file.dir) continue;
    const data = await file.async("uint8array");
    entries.push({ path, data });
  }

  return { sourcePath, twbEntryName, twbXml, entries };
}

/**
 * Writes a TWBX to `outPath` using the provided (patched) `.twb` XML and the
 * preserved resource entries. The `.twb` entry name is kept stable.
 */
export async function writeTwbx(
  outPath: string,
  twbEntryName: string,
  twbXml: string,
  entries: PreservedEntry[],
): Promise<void> {
  const zip = new JSZip();
  // The .twb should be the first entry, mirroring Tableau's own packaging.
  zip.file(twbEntryName, twbXml);
  for (const entry of entries) {
    zip.file(entry.path, entry.data);
  }
  const out = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, out);
}

/** Standard workspace layout for original/working/output artifacts. */
export interface Workspace {
  root: string;
  original: string;
  working: string;
  output: string;
}

/** Resolves and creates the workspace directory layout. */
export async function ensureWorkspace(root = "./workspace"): Promise<Workspace> {
  const ws: Workspace = {
    root,
    original: join(root, "original"),
    working: join(root, "working"),
    output: join(root, "output"),
  };
  await mkdir(ws.original, { recursive: true });
  await mkdir(ws.working, { recursive: true });
  await mkdir(ws.output, { recursive: true });
  return ws;
}

/**
 * Copies an uploaded TWBX into `workspace/original` (never modified) and returns
 * the preserved copy path (spec section 36).
 */
export async function preserveOriginal(
  uploaded: string,
  workspaceRoot = "./workspace",
): Promise<string> {
  const uploadedPath = resolveWorkbookPath(uploaded);
  const ws = await ensureWorkspace(workspaceRoot);
  const dest = join(ws.original, basename(uploadedPath));
  if (existsSync(dest) && dest !== uploadedPath) {
    // Keep a stable original; overwrite only if a new upload with same name.
    await copyFile(uploadedPath, dest);
  } else if (dest !== uploadedPath) {
    await copyFile(uploadedPath, dest);
  }
  return dest;
}

/** Returns true if the file at path looks like a ZIP (TWBX) by magic bytes. */
export async function isZip(path: string): Promise<boolean> {
  const buf = await readFile(path);
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
}
