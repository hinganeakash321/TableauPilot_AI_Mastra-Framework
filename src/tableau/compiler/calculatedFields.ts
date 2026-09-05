/**
 * Deterministic calculated-field creation.
 *
 * Adds user-defined calculated fields to the LOCKED datasource as
 * `<column ...><calculation class='tableau' formula='...' /></column>` entries -
 * exactly how Tableau stores them (see sample_workbook_analysis.md). The LLM never
 * writes this XML; it emits a validated {@link CalculatedFieldSpec} and this module
 * compiles it. The connection/extract inside the datasource is never touched, so
 * the datasource lock is preserved.
 */

import type { CalculatedFieldSpec, FieldSpec } from "../../mastra/schemas/worksheet.js";
import type { FieldInfo } from "../../mastra/schemas/workbook.js";
import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type { DataType, FieldRole } from "../../mastra/schemas/common.js";
import { xmlEscape } from "../xml.js";
import { isAggregateFormula } from "./columnInstance.js";

/** Escapes a string for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Infers a data type from a Tableau formula when the caller didn't specify one. */
function inferDataType(formula: string): DataType {
  const f = formula.toUpperCase();
  if (/\b(TODAY|NOW|DATE|DATETIME|DATETRUNC|DATEADD|DATEPART|MAKEDATE)\s*\(/.test(f)) {
    return "date";
  }
  // String-producing calcs: IF/CASE returning quoted strings, or string functions.
  if (
    /["']/.test(formula) &&
    /\b(IF|CASE|WHEN|LEFT|RIGHT|MID|UPPER|LOWER|TRIM|REPLACE|SPLIT|STR)\s*\(?/.test(f)
  ) {
    return "string";
  }
  if (/\bCONTAINS\s*\(|\b(TRUE|FALSE)\b|\bISNULL\s*\(/.test(f)) {
    // Boolean-ish predicates default to string label unless clearly numeric.
    if (!/[-+*/]/.test(formula)) return "boolean";
  }
  return "real";
}

/** Column-level `type` attribute for a calc field. */
function typeAttrFor(role: FieldRole, dataType: DataType): "nominal" | "ordinal" | "quantitative" {
  if (role === "measure") return "quantitative";
  if (dataType === "string" || dataType === "boolean") return "nominal";
  if (dataType === "date" || dataType === "datetime" || dataType === "integer") return "ordinal";
  return "nominal";
}

/** Generates a synthetic `[Calculation_<16 digits>]` name unique within the TWB. */
function uniqueCalcName(twbXml: string, used: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let digits = "";
    for (let i = 0; i < 16; i += 1) digits += Math.floor(Math.random() * 10).toString();
    const name = `Calculation_${digits}`;
    if (!used.has(name) && !twbXml.includes(name)) {
      used.add(name);
      return name;
    }
  }
  // Extremely unlikely fallback.
  const name = `Calculation_${Date.now()}${Math.floor(Math.random() * 1000)}`;
  used.add(name);
  return name;
}

/** Locates the `[start,end)` char range of the locked `<datasource>...</datasource>`. */
function lockedDatasourceRange(
  twbXml: string,
  dsId: string,
): { start: number; end: number } | null {
  const openRe = new RegExp(`<datasource\\b[^>]*\\bname='${escapeRegExp(dsId)}'[^>]*>`);
  const m = openRe.exec(twbXml);
  if (!m) return null;
  const start = m.index;
  const close = twbXml.indexOf("</datasource>", start + m[0].length);
  if (close === -1) return null;
  return { start, end: close + "</datasource>".length };
}

/** Builds the datasource-level `<column>` XML for one calculated field. */
function calcColumnXml(name: string, spec: {
  caption: string;
  dataType: DataType;
  role: FieldRole;
  formula: string;
}): string {
  const type = typeAttrFor(spec.role, spec.dataType);
  return (
    `      <column caption='${xmlEscape(spec.caption)}' datatype='${spec.dataType}' ` +
    `name='[${name}]' role='${spec.role}' type='${type}'>\n` +
    `        <calculation class='tableau' formula='${xmlEscape(spec.formula)}' />\n` +
    `      </column>`
  );
}

export interface AddCalcResult {
  twbXml: string;
  /** New FieldInfo entries to merge into the field index for reference resolution. */
  newFields: FieldInfo[];
  /** Names that were created (caption -> synthetic name). */
  created: { caption: string; name: string }[];
  errors: string[];
}

/**
 * Adds calculated fields to the locked datasource. Skips any whose name/caption
 * already exists (existing calcs are reused, never duplicated). Returns the updated
 * TWB plus FieldInfo entries so worksheets can reference the new fields by name.
 */
export function addCalculatedFields(
  twbXml: string,
  lock: DatasourceLock,
  calcs: CalculatedFieldSpec[],
  existingFields: FieldInfo[],
): AddCalcResult {
  const errors: string[] = [];
  const created: { caption: string; name: string }[] = [];
  const newFields: FieldInfo[] = [];
  if (!calcs.length) return { twbXml, newFields, created, errors };

  const range = lockedDatasourceRange(twbXml, lock.datasourceId);
  if (!range) {
    return {
      twbXml,
      newFields,
      created,
      errors: [`Locked datasource '${lock.datasourceId}' not found; cannot add calculated fields.`],
    };
  }

  // Index existing field captions/names (case-insensitive) to avoid duplicates.
  const existingByLabel = new Map<string, FieldInfo>();
  for (const f of existingFields) {
    existingByLabel.set(f.name.toLowerCase(), f);
    if (f.caption) existingByLabel.set(f.caption.toLowerCase(), f);
  }

  const usedNames = new Set<string>();
  const columnsToInsert: string[] = [];

  for (const calc of calcs) {
    const label = calc.name.trim();
    if (!label) {
      errors.push("A calculated field is missing a name; skipped.");
      continue;
    }
    if (!calc.formula.trim()) {
      errors.push(`Calculated field '${label}' has an empty formula; skipped.`);
      continue;
    }
    // Reuse an existing field with the same label rather than creating a duplicate.
    const existing = existingByLabel.get(label.toLowerCase());
    if (existing) {
      created.push({ caption: label, name: existing.name });
      continue;
    }

    // A formula that already contains a top-level aggregate (e.g.
    // SUM([Profit])/SUM([Sales])) is itself an aggregate measure. It must be used
    // on shelves as AGG(field) and never re-aggregated with SUM.
    const aggregated = isAggregateFormula(calc.formula);
    const dataType: DataType = calc.dataType ?? inferDataType(calc.formula);
    const role: FieldRole = aggregated
      ? "measure"
      : (calc.role ??
        (dataType === "real" || dataType === "integer" ? "measure" : "dimension"));
    const synthetic = uniqueCalcName(twbXml, usedNames);

    columnsToInsert.push(
      calcColumnXml(synthetic, { caption: label, dataType, role, formula: calc.formula }),
    );

    // Fields referenced in the formula (e.g. [Profit], [Sales]) are source
    // columns this calc depends on - captured so worksheets that use/filter the
    // calc also declare them (resolved by name OR caption at emit time).
    const dependsOn = [
      ...new Set(
        [...calc.formula.matchAll(/\[([^\]]+)\]/g)]
          .map((m) => m[1]!.trim())
          .filter((n) => n && n.toLowerCase() !== label.toLowerCase()),
      ),
    ];

    const info: FieldInfo = {
      name: synthetic,
      caption: label,
      dataType,
      role,
      // Aggregated calcs carry no default aggregation - AGG is applied via the
      // `aggregated` flag when they are placed on a shelf.
      defaultAggregation: role === "measure" && !aggregated ? "sum" : undefined,
      isCalculated: true,
      aggregated,
      datasourceId: lock.datasourceId,
      dependsOn,
    };
    newFields.push(info);
    existingByLabel.set(label.toLowerCase(), info);
    created.push({ caption: label, name: synthetic });
  }

  if (!columnsToInsert.length) {
    return { twbXml, newFields, created, errors };
  }

  const block = twbXml.slice(range.start, range.end);
  const insertion = columnsToInsert.join("\n") + "\n";
  const target = datasourceLevelInsertPoint(block);

  let newBlock: string;
  if (target.kind === "before-column") {
    // Insert before the first datasource-level <column>, keeping its indent intact.
    newBlock =
      block.slice(0, target.index) + insertion + "      " + block.slice(target.index);
  } else if (target.kind === "after-connection") {
    // No datasource-level column yet: insert just after the main </connection>.
    newBlock =
      block.slice(0, target.index) + "\n      " + insertion.trimEnd() + block.slice(target.index);
  } else {
    // Last resort: just before </datasource>.
    const closeRel = block.lastIndexOf("</datasource>");
    newBlock = block.slice(0, closeRel) + insertion + block.slice(closeRel);
  }

  const updated = twbXml.slice(0, range.start) + newBlock + twbXml.slice(range.end);
  return { twbXml: updated, newFields, created, errors };
}

type InsertPoint =
  | { kind: "before-column"; index: number }
  | { kind: "after-connection"; index: number }
  | { kind: "before-datasource-close" };

/**
 * Finds where to insert a datasource-LEVEL `<column>`: right before the first
 * `<column>` that is a direct child of `<datasource>` (i.e. NOT nested inside any
 * `<connection>`/`<relation>` block). A datasource can contain multiple connections
 * (federated + extract) with their own `<relation><columns><column .../>` physical
 * columns whose content model is EMPTY - a calc column there is invalid XML. We scan
 * with connection-depth tracking so we always land at datasource level.
 */
function datasourceLevelInsertPoint(block: string): InsertPoint {
  const dsOpenEnd = block.indexOf(">");
  const start = dsOpenEnd === -1 ? 0 : dsOpenEnd + 1;
  const re = /<connection\b[^>]*?>|<\/connection>|<column\b/g;
  re.lastIndex = start;
  let depth = 0;
  let afterFirstTopClose = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const tag = m[0];
    if (tag === "</connection>") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && afterFirstTopClose === -1) afterFirstTopClose = re.lastIndex;
    } else if (tag.startsWith("<connection")) {
      if (!tag.endsWith("/>")) depth += 1;
    } else if (depth === 0) {
      // A <column> at datasource level (outside any connection).
      return { kind: "before-column", index: m.index };
    }
  }
  if (afterFirstTopClose !== -1) {
    return { kind: "after-connection", index: afterFirstTopClose };
  }
  return { kind: "before-datasource-close" };
}

/**
 * Rewrites worksheet field references so a reference to a calc field's user-facing
 * name resolves to its synthetic `[Calculation_...]` name. (The FieldIndex already
 * resolves by caption, so this is mostly a safety net for explicit specs.)
 */
export function remapCalcReference(
  fieldSpec: FieldSpec,
  created: { caption: string; name: string }[],
): FieldSpec {
  const hit = created.find((c) => c.caption.toLowerCase() === fieldSpec.name.toLowerCase());
  return hit ? { ...fieldSpec, name: hit.name, caption: hit.caption } : fieldSpec;
}
