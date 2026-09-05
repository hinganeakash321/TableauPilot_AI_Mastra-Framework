/**
 * Validators for generated TWB / TWBX artifacts (spec sections 61, 75).
 *
 * Each validator returns a {@link ValidationResult}. Nothing is ever reported as
 * successful without passing these checks (spec rule: never claim success without
 * validation).
 */

import { XMLValidator } from "fast-xml-parser";
import type { ValidationResult, StructuredError } from "../../mastra/schemas/common.js";
import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type { FieldInfo } from "../../mastra/schemas/workbook.js";
import { existingWorksheetNames, getWorkbookDatasourceId } from "../compiler/workbookCompiler.js";
import type { OpenedTwbx } from "../twbx.js";

/** Generated/pseudo fields that are always valid without a datasource column. */
const GENERATED_FIELDS = new Set([
  "Latitude (generated)",
  "Longitude (generated)",
  ":Measure Names",
  ":Measure Values",
  "Number of Records",
  "Measure Names",
  "Measure Values",
]);

function ok(warnings: string[] = []): ValidationResult {
  return { valid: true, errors: [], warnings };
}

function fail(errors: StructuredError[], warnings: string[] = []): ValidationResult {
  return { valid: false, errors, warnings };
}

/** Validates that the TWB XML is well-formed and has the expected root. */
export function validateTwbXml(twbXml: string): ValidationResult {
  const res = XMLValidator.validate(twbXml, { allowBooleanAttributes: true });
  if (res !== true) {
    return fail([
      {
        code: "TWB_XML_INVALID",
        message: `TWB XML is not well-formed: ${res.err.msg} (line ${res.err.line})`,
        details: { line: res.err.line, code: res.err.code },
      },
    ]);
  }
  if (!/<workbook\b/.test(twbXml) || !/<\/workbook>/.test(twbXml)) {
    return fail([
      { code: "TWB_XML_INVALID", message: "Missing <workbook> root element." },
    ]);
  }
  if (!/<datasources>/.test(twbXml)) {
    return fail([
      { code: "TWB_XML_INVALID", message: "Missing <datasources> section." },
    ]);
  }
  return ok();
}

/**
 * Validates that every datasource reference in worksheets points to the locked
 * datasource id (spec section 35).
 */
export function validateDatasourceReferences(
  twbXml: string,
  lock: DatasourceLock,
): ValidationResult {
  const wbDsId = getWorkbookDatasourceId(twbXml);
  if (wbDsId !== lock.datasourceId) {
    return fail([
      {
        code: "DATASOURCE_LOCK_VIOLATION",
        message: `Workbook datasource '${wbDsId}' does not match lock '${lock.datasourceId}'.`,
      },
    ]);
  }

  // Collect datasource ids referenced inside worksheet views.
  const errors: StructuredError[] = [];
  const wsRe = /<worksheet name='([^']*)'>([\s\S]*?)<\/worksheet>/g;
  let m: RegExpExecArray | null;
  while ((m = wsRe.exec(twbXml)) !== null) {
    const name = m[1]!;
    const body = m[2]!;
    const refRe = /\[(federated\.[a-z0-9]+)\]\./g;
    let r: RegExpExecArray | null;
    while ((r = refRe.exec(body)) !== null) {
      if (r[1] !== lock.datasourceId) {
        errors.push({
          code: "DATASOURCE_LOCK_VIOLATION",
          message: `Worksheet '${name}' references foreign datasource '${r[1]}'.`,
        });
      }
    }
  }
  return errors.length ? fail(errors) : ok();
}

/**
 * Validates that every field referenced in worksheets exists in the locked
 * datasource (spec section 45). Uses `<column-instance column='[X]'>` decls.
 */
export function validateFieldExistence(
  twbXml: string,
  fields: FieldInfo[],
  targetWorksheets?: string[],
): ValidationResult {
  const known = new Set(fields.map((f) => f.name.toLowerCase()));
  const scope = targetWorksheets ? new Set(targetWorksheets) : undefined;
  const errors: StructuredError[] = [];
  const warnings: string[] = [];

  const wsRe = /<worksheet name='([^']*)'>([\s\S]*?)<\/worksheet>/g;
  let m: RegExpExecArray | null;
  while ((m = wsRe.exec(twbXml)) !== null) {
    const name = m[1]!;
    if (scope && !scope.has(name)) continue;
    const body = m[2]!;
    // Scan every datasource-dependencies block, but SKIP the Parameters
    // pseudo-datasource: its columns are parameters (e.g. `[Parameter 1]`), not
    // data fields, and are valid by construction.
    const depRe =
      /<datasource-dependencies\b([^>]*)>([\s\S]*?)<\/datasource-dependencies>/g;
    let dep: RegExpExecArray | null;
    while ((dep = depRe.exec(body)) !== null) {
      const depAttrs = dep[1]!;
      const depBlock = dep[2]!;
      if (/\bdatasource='Parameters'/.test(depAttrs)) continue;
      const colRe = /<column\b[^>]*\bname='\[([^\]]+)\]'/g;
      let c: RegExpExecArray | null;
      while ((c = colRe.exec(depBlock)) !== null) {
        const field = c[1]!;
        if (GENERATED_FIELDS.has(field)) continue;
        if (field.includes(":")) continue; // column-instance, checked via its column
        if (!known.has(field.toLowerCase())) {
          errors.push({
            code: "FIELD_NOT_FOUND",
            message: `Worksheet '${name}' references unknown field '${field}'.`,
            suggestions: nearestMatches(field, fields),
          });
        }
      }
    }
  }
  return errors.length ? fail(errors, warnings) : ok(warnings);
}

/** Suggests up to 3 similar field names for a missing field. */
function nearestMatches(target: string, fields: FieldInfo[]): string[] {
  const t = target.toLowerCase();
  return fields
    .map((f) => ({ name: f.name, score: similarity(t, f.name.toLowerCase()) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((x) => x.score > 0.3)
    .map((x) => x.name);
}

/** Cheap similarity metric (shared-substring ratio). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const setA = new Set(a.split(""));
  const setB = new Set(b.split(""));
  const inter = [...setA].filter((ch) => setB.has(ch)).length;
  return inter / Math.max(setA.size, setB.size);
}

/**
 * Validates that every `<window class='worksheet'>` has a matching `<worksheet>`
 * (spec section 61).
 */
export function validateWorksheetReferences(twbXml: string): ValidationResult {
  const worksheets = new Set(existingWorksheetNames(twbXml));
  const errors: StructuredError[] = [];
  const winRe = /<window class='worksheet' name='([^']*)'>/g;
  let m: RegExpExecArray | null;
  while ((m = winRe.exec(twbXml)) !== null) {
    if (!worksheets.has(m[1]!)) {
      errors.push({
        code: "VALIDATION_FAILED",
        message: `Window references missing worksheet '${m[1]}'.`,
      });
    }
  }
  return errors.length ? fail(errors) : ok();
}

/**
 * Validates dashboards: every worksheet referenced by a dashboard zone (chart or
 * filter zone) and by each `<window class='dashboard'>` viewpoint must exist as a
 * real `<worksheet>`. Prevents dangling references that fail to open in Tableau.
 */
export function validateDashboardReferences(twbXml: string): ValidationResult {
  const worksheets = new Set(existingWorksheetNames(twbXml));
  const errors: StructuredError[] = [];

  const dashRe = /<dashboard\b[^>]*\bname='([^']*)'>([\s\S]*?)<\/dashboard>/g;
  let d: RegExpExecArray | null;
  while ((d = dashRe.exec(twbXml)) !== null) {
    const dashName = d[1]!;
    const body = d[2]!;
    // Only <zone> elements carry worksheet references via name=; skip datasource
    // and datasource-dependencies (their name= is the datasource id / field).
    const zonesBlock = /<zones>([\s\S]*?)<\/zones>/.exec(body)?.[1] ?? "";
    const zoneRe = /<zone\b([^>]*)>/g;
    let z: RegExpExecArray | null;
    while ((z = zoneRe.exec(zonesBlock)) !== null) {
      const attrs = z[1]!;
      const nm = /\bname='([^']*)'/.exec(attrs)?.[1];
      if (!nm) continue;
      if (!worksheets.has(nm)) {
        errors.push({
          code: "VALIDATION_FAILED",
          message: `Dashboard '${dashName}' references missing worksheet '${nm}'.`,
        });
      }
    }
  }

  const winRe = /<window class='dashboard' name='([^']*)'>([\s\S]*?)<\/window>/g;
  let w: RegExpExecArray | null;
  while ((w = winRe.exec(twbXml)) !== null) {
    const dashName = w[1]!;
    const vpRe = /<viewpoint name='([^']*)'/g;
    let v: RegExpExecArray | null;
    while ((v = vpRe.exec(w[2]!)) !== null) {
      if (!worksheets.has(v[1]!)) {
        errors.push({
          code: "VALIDATION_FAILED",
          message: `Dashboard '${dashName}' viewpoint references missing worksheet '${v[1]}'.`,
        });
      }
    }
  }

  return errors.length ? fail(errors) : ok();
}

/** Validates TWBX archive structure (spec section 61). */
export function validateTwbxStructure(opened: OpenedTwbx): ValidationResult {
  const errors: StructuredError[] = [];
  const warnings: string[] = [];
  if (!opened.twbEntryName.endsWith(".twb")) {
    errors.push({ code: "TWBX_INVALID", message: "No .twb entry in TWBX." });
  }
  const hasData = opened.entries.some((e) => e.path.startsWith("Data/"));
  if (!hasData) {
    warnings.push("No Data/ resources found (workbook may be live-only).");
  }
  const xmlRes = validateTwbXml(opened.twbXml);
  if (!xmlRes.valid) errors.push(...xmlRes.errors);
  return errors.length ? fail(errors, warnings) : ok(warnings);
}

/**
 * Runs all TWB-level validators and merges results.
 */
export function validateGeneratedTwb(
  twbXml: string,
  lock: DatasourceLock,
  fields: FieldInfo[],
  targetWorksheets?: string[],
): ValidationResult {
  const results = [
    validateTwbXml(twbXml),
    validateDatasourceReferences(twbXml, lock),
    validateFieldExistence(twbXml, fields, targetWorksheets),
    validateWorksheetReferences(twbXml),
    validateDashboardReferences(twbXml),
  ];
  const errors = results.flatMap((r) => r.errors);
  const warnings = results.flatMap((r) => r.warnings);
  return errors.length ? fail(errors, warnings) : ok(warnings);
}
