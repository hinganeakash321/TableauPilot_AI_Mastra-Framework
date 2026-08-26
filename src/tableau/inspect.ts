/**
 * High-level workbook inspection: opens a TWBX (or reads a `.twb`) and returns
 * structured metadata. This is the entry point used by the inspection tools and
 * workflow (spec sections 31-35).
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { openTwbx, isZip } from "./twbx.js";
import { inspectTwbXml } from "./twb.js";
import { resolveWorkbookPath } from "./paths.js";
import type { WorkbookInspectionResult } from "../mastra/schemas/index.js";

/** Inspects a workbook file (`.twbx` or `.twb`). */
export async function inspectWorkbookFile(
  input: string,
): Promise<WorkbookInspectionResult> {
  const path = resolveWorkbookPath(input);
  const workbookName = basename(path);
  if (path.endsWith(".twb") && !(await isZip(path))) {
    const xml = await readFile(path, "utf8");
    return inspectTwbXml(xml, workbookName);
  }
  const opened = await openTwbx(path);
  return inspectTwbXml(opened.twbXml, workbookName);
}
