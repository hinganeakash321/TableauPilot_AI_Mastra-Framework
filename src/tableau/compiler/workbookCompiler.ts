/**
 * Workbook-level compiler: applies a set of worksheet specs to a TWB XML string
 * by inserting `<worksheet>` blocks into `<worksheets>` and matching
 * `<window class='worksheet'>` entries into `<windows>`.
 *
 * Modifications are targeted string operations - the locked datasource block is
 * never touched (spec sections 35, 36, 39). The lock is validated first.
 */

import type { WorksheetSpec } from "../../mastra/schemas/worksheet.js";
import type { FieldInfo } from "../../mastra/schemas/workbook.js";
import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type { StructuredError } from "../../mastra/schemas/common.js";
import { compileWorksheet } from "./worksheetCompiler.js";
import { ensureSection, insertBeforeLast } from "../xml.js";

/** Options controlling collision behavior for a single apply. */
export interface ApplyOptions {
  /** When a worksheet name already exists: replace it or add a versioned copy. */
  onCollision: "modify_existing" | "create_new_version" | "error";
}

/** Result of applying worksheets to a workbook. */
export interface ApplyResult {
  twbXml: string;
  added: string[];
  modified: string[];
  errors: StructuredError[];
}

/** Escapes a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the datasource id referenced by the workbook's first datasource. */
export function getWorkbookDatasourceId(twbXml: string): string | undefined {
  const worksheetsIdx = twbXml.indexOf("<worksheets>");
  const head = worksheetsIdx === -1 ? twbXml : twbXml.slice(0, worksheetsIdx);
  const dsIdx = head.indexOf("<datasources>");
  if (dsIdx === -1) return undefined;
  const m = /<datasource\b[^>]*\bname='([^']*)'/.exec(head.slice(dsIdx));
  return m?.[1];
}

/** Lists existing worksheet names in a TWB. */
export function existingWorksheetNames(twbXml: string): string[] {
  const names: string[] = [];
  const re = /<worksheet name='([^']*)'>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(twbXml)) !== null) names.push(m[1]!);
  return names;
}

/** Removes a worksheet and its window entry by name. */
function removeWorksheet(twbXml: string, name: string): string {
  const n = escapeRegExp(name);
  let out = twbXml.replace(
    new RegExp(`\\s*<worksheet name='${n}'>[\\s\\S]*?<\\/worksheet>`),
    "",
  );
  out = out.replace(
    new RegExp(
      `\\s*<window class='worksheet' name='${n}'>[\\s\\S]*?<\\/window>`,
    ),
    "",
  );
  return out;
}

/** Ensures `<worksheets>` and `<windows>` sections exist. */
function ensureSections(twbXml: string): string {
  let out = ensureSection(twbXml, "<worksheets>", "</worksheets>", "</workbook>");
  out = ensureSection(out, "<windows>", "</windows>", "</workbook>");
  return out;
}

/**
 * Validates that the lock matches the workbook's datasource. Returns an error if
 * there is a mismatch (spec section 35 - DATASOURCE_LOCK_VIOLATION).
 */
export function validateLockAgainstWorkbook(
  twbXml: string,
  lock: DatasourceLock,
): StructuredError | null {
  const wbDsId = getWorkbookDatasourceId(twbXml);
  if (!wbDsId) {
    return {
      code: "DATASOURCE_NOT_FOUND",
      message: "No datasource found in the workbook.",
    };
  }
  if (wbDsId !== lock.datasourceId) {
    return {
      code: "DATASOURCE_LOCK_VIOLATION",
      message:
        `Locked datasource '${lock.datasourceId}' does not match workbook ` +
        `datasource '${wbDsId}'. Refusing to modify the workbook.`,
      details: { locked: lock.datasourceId, workbook: wbDsId },
    };
  }
  return null;
}

/**
 * Applies worksheet specs to a TWB XML string. Enforces the datasource lock and
 * inserts worksheet + window blocks.
 */
export function applyWorksheets(
  twbXml: string,
  specs: WorksheetSpec[],
  lock: DatasourceLock,
  fields: FieldInfo[],
  options: ApplyOptions = { onCollision: "modify_existing" },
): ApplyResult {
  const errors: StructuredError[] = [];
  const added: string[] = [];
  const modified: string[] = [];

  const lockError = validateLockAgainstWorkbook(twbXml, lock);
  if (lockError) {
    return { twbXml, added, modified, errors: [lockError] };
  }

  let out = ensureSections(twbXml);

  for (const spec of specs) {
    const existing = new Set(existingWorksheetNames(out));
    let targetSpec = spec;
    let isModify = false;

    if (existing.has(spec.name)) {
      if (options.onCollision === "error") {
        errors.push({
          code: "WORKSHEET_COLLISION",
          message: `Worksheet '${spec.name}' already exists.`,
          suggestions: ["modify_existing", "create_new_version"],
        });
        continue;
      }
      if (options.onCollision === "create_new_version") {
        let i = 2;
        let candidate = `${spec.name} (${i})`;
        while (existing.has(candidate)) {
          i += 1;
          candidate = `${spec.name} (${i})`;
        }
        targetSpec = { ...spec, name: candidate };
      } else {
        out = removeWorksheet(out, spec.name);
        isModify = true;
      }
    }

    let compiled;
    try {
      compiled = compileWorksheet(targetSpec, lock, fields);
    } catch (err) {
      errors.push({
        code: "VALIDATION_FAILED",
        message: `Failed to compile worksheet '${targetSpec.name}': ${
          (err as Error).message
        }`,
      });
      continue;
    }

    out = insertBeforeLast(out, "</worksheets>", `\n${compiled.worksheetXml}\n  `);
    out = insertBeforeLast(out, "</windows>", `\n${compiled.windowXml}\n  `);

    if (isModify) modified.push(targetSpec.name);
    else added.push(targetSpec.name);
  }

  return { twbXml: out, added, modified, errors };
}
