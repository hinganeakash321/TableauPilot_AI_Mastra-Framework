/**
 * Deterministic column-instance naming (spec section 39, sample_workbook_analysis.md).
 *
 * Tableau references pills as `[<dsId>].[<deriv>:<Field>:<typekey>]`. This module
 * derives the instance name, the `<column>` and `<column-instance>` declarations,
 * and the shelf reference - all from the SAME logic so they are always consistent.
 * Consistency + real field names + the locked datasource id are what make the
 * generated workbook open correctly in Tableau.
 */

import type {
  Aggregation,
  DataType,
  DateDerivation,
  FieldRole,
} from "../../mastra/schemas/common.js";
import { xmlEscape } from "../xml.js";

/** Input describing how a field is used on a shelf/encoding. */
export interface PillInput {
  /** Field name without brackets, e.g. `Sales`. */
  name: string;
  role: FieldRole;
  dataType: DataType;
  /** Aggregation for measures (defaults to `sum`). */
  aggregation?: Aggregation;
  /**
   * The field is ALREADY aggregated (its formula contains a top-level aggregate),
   * so it must be used as `AGG(field)` - Tableau `derivation='User'`, instance
   * `[usr:<name>:qk]`. When true this wins over `aggregation` (no re-aggregation).
   */
  aggregated?: boolean;
  /** Date part/truncation for date dimensions. */
  dateDerivation?: DateDerivation;
  /** Whether a date dimension is rendered as a continuous (green) axis. */
  continuousDate?: boolean;
  /**
   * Explicit discrete/continuous override (blue vs green). When set it wins over
   * the natural default: `false` forces the pill DISCRETE (measures become
   * `ordinal`/`ok`; dates use the discrete part), `true` forces it CONTINUOUS
   * (dates truncate; a numeric dimension becomes `quantitative`/`qk`).
   */
  continuous?: boolean;
  /** Optional number/date format string. */
  format?: string;
}

/**
 * True when a Tableau formula is ALREADY aggregated: it contains a top-level
 * aggregate function (SUM/AVG/COUNT/COUNTD/MIN/MAX/MEDIAN/ATTR/STDEV/VAR/...).
 * Aggregates nested inside an LOD expression (`{FIXED ...}`) do NOT count - a
 * FIXED/INCLUDE/EXCLUDE result is re-aggregated at viz level (Tableau applies
 * SUM), so those fields are treated as normal measures.
 */
export function isAggregateFormula(formula: string): boolean {
  // Drop LOD blocks and string literals so their contents can't cause a match.
  let cleaned = formula;
  // Remove up to two levels of {…} (LOD) nesting.
  cleaned = cleaned.replace(/\{[^{}]*\}/g, " ");
  cleaned = cleaned.replace(/\{[^{}]*\}/g, " ");
  cleaned = cleaned.replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
  return /\b(SUM|AVG|COUNT|COUNTD|MIN|MAX|MEDIAN|ATTR|STDEV|STDEVP|VAR|VARP|PERCENTILE|CORR|COVAR|COVARP)\s*\(/i.test(
    cleaned,
  );
}

/** Fully resolved pill with all XML fragments derived. */
export interface ResolvedPill {
  name: string;
  /** Instance name without brackets, e.g. `sum:Sales:qk`. */
  instanceName: string;
  /** Type attribute for the column-instance/column element. */
  typeAttr: "nominal" | "ordinal" | "quantitative";
  /** Derivation attribute, e.g. `Sum`, `None`, `Year-Trunc`. */
  derivationAttr: string;
  /** `<column .../>` declaration for datasource-dependencies. */
  columnDecl: string;
  /** `<column-instance .../>` declaration for datasource-dependencies. */
  columnInstanceDecl: string;
  /** Returns the shelf reference `[<dsId>].[<instance>]`. */
  ref(dsId: string): string;
}

const AGG_CODE: Record<Aggregation, string> = {
  none: "none",
  sum: "sum",
  avg: "avg",
  count: "cnt",
  countd: "ctd",
  min: "min",
  max: "max",
  median: "med",
};

const AGG_DERIVATION: Record<Aggregation, string> = {
  none: "None",
  sum: "Sum",
  avg: "Avg",
  count: "Count",
  countd: "CountD",
  min: "Minimum",
  max: "Maximum",
  median: "Median",
};

const DATE_DISCRETE_CODE: Record<Exclude<DateDerivation, "none">, string> = {
  year: "yr",
  quarter: "qr",
  month: "mn",
  week: "wk",
  day: "dy",
  weekday: "wd",
  hour: "hr",
  minute: "mi",
};

const DATE_DISCRETE_DERIVATION: Record<
  Exclude<DateDerivation, "none">,
  string
> = {
  year: "Year",
  quarter: "Quarter",
  month: "Month",
  week: "Week",
  day: "Day",
  weekday: "Weekday",
  hour: "Hour",
  minute: "Minute",
};

const DATE_CONTINUOUS_CODE: Record<Exclude<DateDerivation, "none">, string> = {
  year: "tyr",
  quarter: "tqr",
  month: "tmn",
  week: "twk",
  day: "tdy",
  weekday: "twd",
  hour: "thr",
  minute: "tmi",
};

const DATE_CONTINUOUS_DERIVATION: Record<
  Exclude<DateDerivation, "none">,
  string
> = {
  year: "Year-Trunc",
  quarter: "Quarter-Trunc",
  month: "Month-Trunc",
  week: "Week-Trunc",
  day: "Day-Trunc",
  weekday: "Weekday-Trunc",
  hour: "Hour-Trunc",
  minute: "Minute-Trunc",
};

/** Column-level `type` attribute (independent of derivation). */
function columnTypeAttr(input: PillInput): "nominal" | "ordinal" | "quantitative" {
  if (input.role === "measure") return "quantitative";
  if (input.dataType === "string" || input.dataType === "boolean") {
    return "nominal";
  }
  return "ordinal";
}

/**
 * Builds a plain `<column .../>` declaration for a source/base column (no
 * column-instance). Used to co-declare the columns a derived field (bin, group,
 * calc) depends on, so Tableau can resolve the derived field in a worksheet.
 */
export function plainColumnDecl(field: {
  name: string;
  dataType: DataType;
  role: FieldRole;
  defaultFormat?: string;
}): string {
  const colType =
    field.role === "measure"
      ? "quantitative"
      : field.dataType === "string" || field.dataType === "boolean"
        ? "nominal"
        : "ordinal";
  const formatAttr = field.defaultFormat
    ? ` default-format='${xmlEscape(field.defaultFormat)}'`
    : "";
  return (
    `<column datatype='${field.dataType}'${formatAttr} name='[${field.name}]' ` +
    `role='${field.role}' type='${colType}' />`
  );
}

/** Resolves a pill descriptor from a PillInput. */
export function resolvePill(input: PillInput): ResolvedPill {
  const name = input.name;
  const bracket = `[${name}]`;
  const colType = columnTypeAttr(input);

  let code: string;
  let derivationAttr: string;
  let typeAttr: ResolvedPill["typeAttr"];

  if (input.role === "measure" && input.aggregated) {
    // Already-aggregated calc -> AGG(field): usr / User, never re-aggregated.
    code = "usr";
    derivationAttr = "User";
    // A measure is continuous (quantitative/qk) by default; `continuous: false`
    // makes it a DISCRETE measure (ordinal/ok).
    typeAttr = input.continuous === false ? "ordinal" : "quantitative";
  } else if (input.role === "measure") {
    const agg: Aggregation =
      input.aggregation && input.aggregation !== "none"
        ? input.aggregation
        : "sum";
    code = AGG_CODE[agg];
    derivationAttr = AGG_DERIVATION[agg];
    typeAttr = input.continuous === false ? "ordinal" : "quantitative";
  } else if (
    input.dataType === "date" ||
    input.dataType === "datetime"
  ) {
    // Explicit override wins over the chart-family default for the date axis.
    const continuous = input.continuous ?? input.continuousDate ?? false;
    const deriv = input.dateDerivation ?? "none";
    if (deriv === "none") {
      // Plain exact date: continuous => quantitative axis, else discrete.
      code = "none";
      derivationAttr = "None";
      typeAttr = continuous ? "quantitative" : "ordinal";
    } else if (continuous) {
      code = DATE_CONTINUOUS_CODE[deriv];
      derivationAttr = DATE_CONTINUOUS_DERIVATION[deriv];
      typeAttr = "quantitative";
    } else {
      code = DATE_DISCRETE_CODE[deriv];
      derivationAttr = DATE_DISCRETE_DERIVATION[deriv];
      typeAttr = "ordinal";
    }
  } else {
    // Nominal / ordinal dimension. `continuous: true` turns a numeric dimension
    // into a continuous (quantitative/qk) pill.
    code = "none";
    derivationAttr = "None";
    typeAttr = input.continuous === true ? "quantitative" : colType;
  }

  const instanceName = `${code}:${name}:${typeKey(typeAttr)}`;
  const bracketInstance = `[${instanceName}]`;

  const formatAttr = input.format
    ? ` default-format='${xmlEscape(input.format)}'`
    : "";
  const columnDecl =
    `<column datatype='${input.dataType}'${formatAttr} ` +
    `name='${bracket}' role='${input.role}' type='${colType}' />`;
  const columnInstanceDecl =
    `<column-instance column='${bracket}' derivation='${derivationAttr}' ` +
    `name='${bracketInstance}' pivot='key' type='${typeAttr}' />`;

  return {
    name,
    instanceName,
    typeAttr,
    derivationAttr,
    columnDecl,
    columnInstanceDecl,
    ref: (dsId: string) => `[${dsId}].${bracketInstance}`,
  };
}

/** Type-key suffix for an instance name. */
function typeKey(typeAttr: ResolvedPill["typeAttr"]): "nk" | "ok" | "qk" {
  switch (typeAttr) {
    case "nominal":
      return "nk";
    case "ordinal":
      return "ok";
    case "quantitative":
      return "qk";
  }
}
