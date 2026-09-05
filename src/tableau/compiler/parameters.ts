/**
 * Deterministic parameter creation.
 *
 * Tableau stores parameters in a special inline pseudo-datasource
 * `<datasource name='Parameters'>` as `<column ... param-domain-type='...'>` with
 * a nested `<calculation>` holding the current value (see the sample workbook's
 * "Top N" parameter). This module creates parameters there and re-emits a
 * parameter's `<column>` for a worksheet's `<datasource-dependencies>` block so a
 * Top-N filter (or any consumer) can reference `[Parameters].[Parameter N]`.
 *
 * The LLM never writes this XML; it emits a validated {@link ParameterSpec} and
 * this module compiles it. The real data datasource is never touched, so the
 * datasource lock is preserved.
 */

import type { ParameterSpec } from "../../mastra/schemas/worksheet.js";
import type { DataType } from "../../mastra/schemas/common.js";
import { xmlEscape } from "../xml.js";

/** A fully resolved parameter column (as stored in the Parameters datasource). */
export interface ParameterColumn {
  /** Display name / caption, e.g. `Top N`. */
  caption: string;
  /** Internal name without brackets, e.g. `Parameter 1`. */
  name: string;
  datatype: DataType;
  paramDomainType: "any" | "list" | "range";
  role: "measure" | "dimension";
  type: "quantitative" | "nominal" | "ordinal";
  /** Current value, already escaped/quoted for XML (e.g. `5` or `&quot;A&quot;`). */
  value: string;
  /** Calculation formula (mirrors `value`). */
  formula: string;
  /** Allowed members for a `list` domain (values already escaped/quoted). */
  members?: string[];
}

/** Renders a parameter `<column>` block at the given indent. */
export function parameterColumnXml(p: ParameterColumn, indent: string): string {
  const open =
    `${indent}<column caption='${xmlEscape(p.caption)}' datatype='${p.datatype}' ` +
    `name='[${p.name}]' param-domain-type='${p.paramDomainType}' role='${p.role}' ` +
    `type='${p.type}' value='${p.value}'>`;
  const calc = `${indent}  <calculation class='tableau' formula='${p.formula}' />`;
  let membersXml = "";
  if (p.paramDomainType === "list" && p.members?.length) {
    membersXml =
      `\n${indent}  <members>\n` +
      p.members.map((m) => `${indent}    <member value='${m}' />`).join("\n") +
      `\n${indent}  </members>`;
  }
  return `${open}\n${calc}${membersXml}\n${indent}</column>`;
}

/** Maps a data type to (role, type) as Tableau writes them for a parameter. */
function roleAndType(dt: DataType): {
  role: "measure" | "dimension";
  type: "quantitative" | "nominal" | "ordinal";
} {
  if (dt === "integer" || dt === "real") {
    return { role: "measure", type: "quantitative" };
  }
  if (dt === "date" || dt === "datetime") {
    return { role: "dimension", type: "ordinal" };
  }
  return { role: "dimension", type: "nominal" };
}

/** Quotes a raw value for a parameter based on its data type. */
function encodeValue(dt: DataType, raw: string): string {
  if (dt === "string") return `&quot;${xmlEscape(raw)}&quot;`;
  if (dt === "boolean") return raw === "true" || raw === "1" ? "true" : "false";
  // integer / real / date -> bare (dates are typically `#YYYY-MM-DD#`, passed as-is).
  return xmlEscape(raw);
}

/** Builds a ParameterColumn from a validated spec + assigned internal name. */
function specToColumn(spec: ParameterSpec, name: string): ParameterColumn {
  const dt = spec.dataType;
  const { role, type } = roleAndType(dt);
  const domain: ParameterColumn["paramDomainType"] =
    spec.domain === "list" ? "list" : spec.domain === "range" ? "range" : "any";
  const rawCurrent =
    spec.currentValue ??
    (dt === "integer" || dt === "real"
      ? "0"
      : dt === "boolean"
        ? "true"
        : "");
  const value = encodeValue(dt, rawCurrent);
  const members =
    domain === "list" && spec.allowedValues?.length
      ? spec.allowedValues.map((v) => encodeValue(dt, v))
      : undefined;
  return {
    caption: spec.name.trim(),
    name,
    datatype: dt,
    paramDomainType: domain,
    role,
    type,
    value,
    formula: value,
    members,
  };
}

/** Extracts a trailing integer from a `Parameter N` name (or NaN). */
function parameterNumber(name: string): number {
  const m = /(\d+)\s*$/.exec(name);
  return m ? Number(m[1]) : NaN;
}

/** Picks the next free `Parameter N` name. */
function nextParameterName(used: Set<number>): string {
  let n = 1;
  while (used.has(n)) n += 1;
  used.add(n);
  return `Parameter ${n}`;
}

/** Locates the `[start,end)` range of the `<datasource name='Parameters'>` block. */
function parametersDatasourceRange(
  twbXml: string,
): { start: number; end: number; open: string } | null {
  const openRe = /<datasource\b[^>]*\bname='Parameters'[^>]*>/;
  const m = openRe.exec(twbXml);
  if (!m) return null;
  const start = m.index;
  const close = twbXml.indexOf("</datasource>", start + m[0].length);
  if (close === -1) return null;
  return { start, end: close + "</datasource>".length, open: m[0] };
}

/** Parses the parameter columns already present in the Parameters datasource. */
export function parseExistingParameterColumns(twbXml: string): ParameterColumn[] {
  const range = parametersDatasourceRange(twbXml);
  if (!range) return [];
  const block = twbXml.slice(range.start, range.end);
  const cols: ParameterColumn[] = [];
  const colRe = /<column\b([^>]*?)(\/>|>([\s\S]*?)<\/column>)/g;
  let m: RegExpExecArray | null;
  while ((m = colRe.exec(block)) !== null) {
    const attrs = m[1] ?? "";
    const inner = m[3] ?? "";
    const attr = (a: string) =>
      new RegExp(`\\b${a}='([^']*)'`).exec(attrs)?.[1];
    const rawName = attr("name");
    if (!rawName) continue;
    const name = rawName.replace(/^\[/, "").replace(/\]$/, "");
    const caption = attr("caption") ?? name;
    const datatype = (attr("datatype") as DataType) ?? "integer";
    const paramDomainType =
      (attr("param-domain-type") as ParameterColumn["paramDomainType"]) ?? "any";
    const role = (attr("role") as "measure" | "dimension") ?? "measure";
    const type =
      (attr("type") as ParameterColumn["type"]) ?? "quantitative";
    const value = attr("value") ?? "0";
    const formula =
      /<calculation\b[^>]*\bformula='([^']*)'/.exec(inner)?.[1] ?? value;
    const members = [...inner.matchAll(/<member\b[^>]*\bvalue='([^']*)'/g)].map(
      (mm) => mm[1]!,
    );
    cols.push({
      caption,
      name,
      datatype,
      paramDomainType,
      role,
      type,
      value,
      formula,
      members: members.length ? members : undefined,
    });
  }
  return cols;
}

export interface AddParametersResult {
  twbXml: string;
  /** Every parameter column now available (existing + newly created). */
  columns: ParameterColumn[];
  /** Newly created parameters (caption -> internal name). */
  created: { caption: string; name: string }[];
  errors: string[];
}

/**
 * Creates parameters in the workbook's Parameters datasource (creating that
 * datasource if it does not exist). Parameters whose caption already exists are
 * reused, never duplicated. Returns the updated TWB plus the full column list for
 * dependency resolution.
 */
export function addParameters(
  twbXml: string,
  specs: ParameterSpec[],
): AddParametersResult {
  const errors: string[] = [];
  const created: { caption: string; name: string }[] = [];
  const existing = parseExistingParameterColumns(twbXml);
  const byCaption = new Map(existing.map((c) => [c.caption.toLowerCase(), c]));
  const usedNums = new Set<number>();
  for (const c of existing) {
    const n = parameterNumber(c.name);
    if (!Number.isNaN(n)) usedNums.add(n);
  }

  const all: ParameterColumn[] = [...existing];
  const newColumns: ParameterColumn[] = [];

  for (const spec of specs) {
    const label = spec.name.trim();
    if (!label) {
      errors.push("A parameter is missing a name; skipped.");
      continue;
    }
    const hit = byCaption.get(label.toLowerCase());
    if (hit) {
      created.push({ caption: label, name: hit.name });
      continue;
    }
    const name = nextParameterName(usedNums);
    const col = specToColumn(spec, name);
    newColumns.push(col);
    all.push(col);
    byCaption.set(label.toLowerCase(), col);
    created.push({ caption: label, name });
  }

  if (!newColumns.length) {
    return { twbXml, columns: all, created, errors };
  }

  const out = insertParameterColumns(twbXml, newColumns);
  return { twbXml: out, columns: all, created, errors };
}

/** Inserts new parameter columns, creating the Parameters datasource if needed. */
function insertParameterColumns(
  twbXml: string,
  columns: ParameterColumn[],
): string {
  const range = parametersDatasourceRange(twbXml);
  const colsXml = columns
    .map((c) => parameterColumnXml(c, "      "))
    .join("\n");

  if (range) {
    // Insert before the Parameters datasource's closing tag.
    const closeIdx = twbXml.lastIndexOf("</datasource>", range.end);
    return (
      twbXml.slice(0, closeIdx) + colsXml + "\n    " + twbXml.slice(closeIdx)
    );
  }

  // No Parameters datasource yet - create one as the first child of <datasources>.
  const block =
    `    <datasource hasconnection='false' inline='true' name='Parameters' version='18.1'>\n` +
    `      <aliases enabled='yes' />\n` +
    colsXml +
    `\n    </datasource>`;
  if (twbXml.includes("<datasources>")) {
    return twbXml.replace("<datasources>", `<datasources>\n${block}`);
  }
  // Extremely unlikely: no datasources section at all.
  return twbXml;
}
