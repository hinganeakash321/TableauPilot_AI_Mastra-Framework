/**
 * TWB metadata extraction (read-only).
 *
 * Parses a `.twb` XML string into a {@link WorkbookInspectionResult} using
 * targeted, resilient extraction. Only metadata is produced - the full XML is
 * never surfaced to the model (spec section 57).
 */

import type {
  CalculatedFieldInfo,
  ConnectionInfo,
  DatasourceInfo,
  FieldInfo,
  ParameterInfo,
  WorkbookInspectionResult,
  WorksheetInfo,
} from "../mastra/schemas/index.js";
import type {
  Aggregation,
  ConnectionMode,
  DataType,
  FieldRole,
} from "../mastra/schemas/common.js";
import { isAggregateFormula } from "./compiler/columnInstance.js";

/** Decodes XML entities in attribute/text values. */
function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

/** Strips a single pair of surrounding square brackets: `[Sales]` -> `Sales`. */
function stripBrackets(name: string): string {
  return name.replace(/^\[/, "").replace(/\]$/, "");
}

/** Reads a single-quoted attribute from an element's opening tag text. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}='([^']*)'`).exec(tag);
  return m ? xmlUnescape(m[1]!) : undefined;
}

/** Normalizes a Tableau local-type into our DataType enum. */
function normalizeDataType(raw: string | undefined): DataType {
  switch ((raw ?? "").toLowerCase()) {
    case "integer":
      return "integer";
    case "real":
      return "real";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "boolean":
      return "boolean";
    case "table":
      return "table";
    default:
      return "string";
  }
}

/** Maps a Tableau metadata `<aggregation>` value to our Aggregation enum. */
function normalizeAggregation(raw: string | undefined): Aggregation | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "sum":
      return "sum";
    case "avg":
      return "avg";
    case "count":
      return "count";
    case "countd":
      return "countd";
    case "min":
      return "min";
    case "max":
      return "max";
    case "median":
      return "median";
    default:
      return undefined;
  }
}

/** Extracts the workbook-level `<datasources>...</datasources>` block. */
function extractWorkbookDatasourcesBlock(xml: string): string {
  const worksheetsIdx = xml.indexOf("<worksheets>");
  const head = worksheetsIdx === -1 ? xml : xml.slice(0, worksheetsIdx);
  const start = head.indexOf("<datasources>");
  const end = head.indexOf("</datasources>");
  if (start === -1 || end === -1) return "";
  return head.slice(start, end + "</datasources>".length);
}

/** Splits a datasources block into individual datasource element strings. */
function splitDatasources(block: string): string[] {
  const results: string[] = [];
  const re = /<datasource\b[^>]*>[\s\S]*?<\/datasource>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    results.push(m[0]);
  }
  return results;
}

/** Parses connections from a datasource block. */
function parseConnections(dsBlock: string): ConnectionInfo[] {
  const connections: ConnectionInfo[] = [];
  const namedRe =
    /<named-connection\b([^>]*)>\s*<connection\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = namedRe.exec(dsBlock)) !== null) {
    const namedTag = m[1]!;
    const connTag = m[2]!;
    connections.push({
      name: attr(namedTag, "name") ?? "connection",
      caption: attr(namedTag, "caption"),
      connectionClass: attr(connTag, "class") ?? "unknown",
      server: attr(connTag, "server") || undefined,
      filename: attr(connTag, "filename") || undefined,
    });
  }
  return connections;
}

/** Determines connection mode for a datasource block. */
function detectConnectionMode(dsBlock: string): {
  mode: ConnectionMode;
  hasExtract: boolean;
} {
  const hasExtract =
    /<extract\b/.test(dsBlock) ||
    /class='hyper'/.test(dsBlock) ||
    /\.hyper/.test(dsBlock);
  return { mode: hasExtract ? "extract" : "live", hasExtract };
}

/** Parses table/relation names from a datasource block. */
function parseTables(dsBlock: string): string[] {
  const tables = new Set<string>();
  const re = /<relation\b[^>]*\bname='([^']*)'[^>]*type='table'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dsBlock)) !== null) {
    tables.add(xmlUnescape(m[1]!));
  }
  return [...tables];
}

/**
 * Infers a field role from data type + default aggregation when not explicitly
 * declared. Numeric fields that Tableau aggregates by Sum/Avg are measures.
 */
function inferRole(
  dataType: DataType,
  aggregation: Aggregation | undefined,
): FieldRole {
  if (
    (dataType === "real" || dataType === "integer") &&
    (aggregation === "sum" || aggregation === "avg")
  ) {
    return "measure";
  }
  return "dimension";
}

/** Parses fields for a single datasource block. */
function parseFields(
  dsBlock: string,
  datasourceId: string,
): { fields: FieldInfo[]; calculated: CalculatedFieldInfo[] } {
  const byName = new Map<string, FieldInfo>();
  const calculated: CalculatedFieldInfo[] = [];

  // 1. Base fields from metadata-records (physical columns).
  const recRe = /<metadata-record class='column'>([\s\S]*?)<\/metadata-record>/g;
  let m: RegExpExecArray | null;
  while ((m = recRe.exec(dsBlock)) !== null) {
    const rec = m[1]!;
    const localName = /<local-name>([\s\S]*?)<\/local-name>/.exec(rec)?.[1];
    if (!localName) continue;
    const name = stripBrackets(xmlUnescape(localName));
    if (name.startsWith("__tableau_internal")) continue;
    const localType = /<local-type>([\s\S]*?)<\/local-type>/.exec(rec)?.[1];
    const aggRaw = /<aggregation>([\s\S]*?)<\/aggregation>/.exec(rec)?.[1];
    const dataType = normalizeDataType(localType);
    const aggregation = normalizeAggregation(aggRaw);
    byName.set(name.toLowerCase(), {
      name,
      caption: undefined,
      dataType,
      role: inferRole(dataType, aggregation),
      defaultAggregation: aggregation,
      isCalculated: false,
      aggregated: false,
      datasourceId,
      dependsOn: [],
    });
  }

  // 2. Field-level <column> declarations (authoritative role/caption/format,
  //    and calculated fields).
  const colRe = /<column\b([^>]*?)(\/>|>([\s\S]*?)<\/column>)/g;
  while ((m = colRe.exec(dsBlock)) !== null) {
    const tag = m[1]!;
    const inner = m[3] ?? "";
    const rawName = attr(tag, "name");
    const dataTypeRaw = attr(tag, "datatype");
    if (!rawName) continue;
    if (rawName.includes("__tableau_internal_object_id__")) continue;
    if (dataTypeRaw === "table") continue;
    const name = stripBrackets(rawName);
    const caption = attr(tag, "caption");
    const roleRaw = attr(tag, "role");
    const dataType = normalizeDataType(dataTypeRaw);
    const defaultFormat = attr(tag, "default-format");

    const calcMatch = /<calculation\b[^>]*\bformula='([^']*)'/.exec(inner);
    let aggregated = false;
    if (calcMatch) {
      const formula = xmlUnescape(calcMatch[1]!);
      aggregated = isAggregateFormula(formula);
      calculated.push({
        name,
        caption,
        formula,
        dataType,
        role: (roleRaw as FieldRole | undefined) ?? undefined,
        datasourceId,
      });
    }

    // Source columns this field derives from. Bins/groups reference their source
    // via `<calculation ... column='[patient_age]'>`; these must be co-declared
    // in every worksheet that uses/filters the derived field.
    const dependsOn: string[] = [];
    for (const cm of inner.matchAll(/<calculation\b[^>]*\bcolumn='(\[[^']*\])'/g)) {
      const src = stripBrackets(xmlUnescape(cm[1]!));
      if (src && src !== name && !dependsOn.includes(src)) dependsOn.push(src);
    }

    const existing = byName.get(name.toLowerCase());
    // An already-aggregated calc is always a measure used as AGG(field).
    const role: FieldRole = aggregated
      ? "measure"
      : ((roleRaw as FieldRole | undefined) ??
        existing?.role ??
        inferRole(dataType, existing?.defaultAggregation));
    byName.set(name.toLowerCase(), {
      name,
      caption: caption ?? existing?.caption,
      dataType: existing?.dataType ?? dataType,
      role,
      defaultAggregation: existing?.defaultAggregation,
      isCalculated: Boolean(calcMatch) || existing?.isCalculated || false,
      aggregated: aggregated || existing?.aggregated || false,
      datasourceId,
      defaultFormat: defaultFormat ?? existing?.defaultFormat,
      dependsOn:
        dependsOn.length > 0 ? dependsOn : (existing?.dependsOn ?? []),
    });
  }

  return { fields: [...byName.values()], calculated };
}

/** Parses parameters from a dedicated `Parameters` datasource, if present. */
function parseParameters(datasourceBlocks: string[]): ParameterInfo[] {
  const params: ParameterInfo[] = [];
  for (const block of datasourceBlocks) {
    const openTag = /<datasource\b[^>]*>/.exec(block)?.[0] ?? "";
    const name = attr(openTag, "name");
    if (name !== "Parameters") continue;
    const colRe = /<column\b([^>]*?)(\/>|>([\s\S]*?)<\/column>)/g;
    let m: RegExpExecArray | null;
    while ((m = colRe.exec(block)) !== null) {
      const tag = m[1]!;
      const rawName = attr(tag, "name");
      if (!rawName) continue;
      params.push({
        name: stripBrackets(rawName),
        caption: attr(tag, "caption"),
        dataType: normalizeDataType(attr(tag, "datatype")),
        currentValue: attr(tag, "value"),
      });
    }
  }
  return params;
}

/** Parses worksheet names and the fields they reference. */
function parseWorksheets(xml: string): WorksheetInfo[] {
  const results: WorksheetInfo[] = [];
  const re = /<worksheet name='([^']*)'>([\s\S]*?)<\/worksheet>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = xmlUnescape(m[1]!);
    const body = m[2]!;
    const dsId = attr(
      /<datasource-dependencies\b[^>]*>/.exec(body)?.[0] ?? "",
      "datasource",
    );
    const used = new Set<string>();
    const pillRe = /\[[^\]]+\]\.\[[^\]]*:([^:\]]+):[^\]]*\]/g;
    let p: RegExpExecArray | null;
    while ((p = pillRe.exec(body)) !== null) {
      used.add(p[1]!);
    }
    results.push({ name, datasourceId: dsId, usedFields: [...used] });
  }
  return results;
}

/**
 * Extracts full workbook metadata from a `.twb` XML string.
 */
export function inspectTwbXml(
  xml: string,
  workbookName: string,
): WorkbookInspectionResult {
  const wbTag = /<workbook\b[^>]*>/.exec(xml)?.[0] ?? "";
  const tableauVersion = attr(wbTag, "version");
  const sourceBuild = attr(wbTag, "source-build");

  const dsBlock = extractWorkbookDatasourcesBlock(xml);
  const dsElements = splitDatasources(dsBlock).filter((b) => {
    const openTag = /<datasource\b[^>]*>/.exec(b)?.[0] ?? "";
    // Exclude the Parameters pseudo-datasource from the "datasources" list.
    return attr(openTag, "name") !== "Parameters";
  });

  const datasources: DatasourceInfo[] = [];
  const allFields: FieldInfo[] = [];
  const allCalculated: CalculatedFieldInfo[] = [];

  for (const block of dsElements) {
    const openTag = /<datasource\b[^>]*>/.exec(block)?.[0] ?? "";
    const id = attr(openTag, "name") ?? "unknown";
    const caption = attr(openTag, "caption");
    const connectionClass =
      /<connection class='([^']*)'/.exec(block)?.[1] ?? "federated";
    const { mode, hasExtract } = detectConnectionMode(block);
    const connections = parseConnections(block);
    const tables = parseTables(block);
    const { fields, calculated } = parseFields(block, id);

    datasources.push({
      id,
      name: caption ?? id,
      caption,
      connectionType: connectionClass,
      connectionMode: mode,
      connections,
      hasExtract,
      tables,
    });
    allFields.push(...fields);
    allCalculated.push(...calculated);
  }

  const parameters = parseParameters(splitDatasources(dsBlock));
  const worksheets = parseWorksheets(xml);

  const dimensions = allFields.filter((f) => f.role === "dimension").length;
  const measures = allFields.filter((f) => f.role === "measure").length;

  return {
    workbookName,
    tableauVersion,
    sourceBuild,
    datasources,
    fields: allFields,
    calculatedFields: allCalculated,
    parameters,
    worksheets,
    counts: {
      datasources: datasources.length,
      fields: allFields.length,
      dimensions,
      measures,
      calculatedFields: allCalculated.length,
      parameters: parameters.length,
      worksheets: worksheets.length,
    },
  };
}
