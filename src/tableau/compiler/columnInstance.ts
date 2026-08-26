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
  /** Date part/truncation for date dimensions. */
  dateDerivation?: DateDerivation;
  /** Whether a date dimension is rendered as a continuous (green) axis. */
  continuousDate?: boolean;
  /** Optional number/date format string. */
  format?: string;
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

/** Resolves a pill descriptor from a PillInput. */
export function resolvePill(input: PillInput): ResolvedPill {
  const name = input.name;
  const bracket = `[${name}]`;
  const colType = columnTypeAttr(input);

  let code: string;
  let derivationAttr: string;
  let typeAttr: ResolvedPill["typeAttr"];

  if (input.role === "measure") {
    const agg: Aggregation =
      input.aggregation && input.aggregation !== "none"
        ? input.aggregation
        : "sum";
    code = AGG_CODE[agg];
    derivationAttr = AGG_DERIVATION[agg];
    typeAttr = "quantitative";
  } else if (
    input.dataType === "date" ||
    input.dataType === "datetime"
  ) {
    const deriv = input.dateDerivation ?? "none";
    if (deriv === "none") {
      // Plain date dimension: nominal-ish exact date (discrete none).
      code = "none";
      derivationAttr = "None";
      typeAttr = input.continuousDate ? "quantitative" : "ordinal";
    } else if (input.continuousDate) {
      code = DATE_CONTINUOUS_CODE[deriv];
      derivationAttr = DATE_CONTINUOUS_DERIVATION[deriv];
      typeAttr = "quantitative";
    } else {
      code = DATE_DISCRETE_CODE[deriv];
      derivationAttr = DATE_DISCRETE_DERIVATION[deriv];
      typeAttr = "ordinal";
    }
  } else {
    // Nominal / ordinal dimension.
    code = "none";
    derivationAttr = "None";
    typeAttr = colType;
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
