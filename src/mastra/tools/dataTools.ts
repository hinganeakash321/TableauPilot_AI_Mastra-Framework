/**
 * Data tools: read the UNDERLYING data inside a workbook's `.hyper` extract.
 *
 * Answers questions the metadata alone cannot - e.g. "how many years of data are
 * present", value ranges, distinct counts, row counts, and small data previews.
 * All access is READ-ONLY; the workbook and its extract are never modified.
 */

import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import {
  listTables,
  primaryTable,
  profileColumn,
  runReadOnlyQuery,
} from "../../tableau/data/hyperReader.js";
import { runTool, toolResult } from "./_shared.js";

const HyperColumnSchema = z.object({ name: z.string(), typeName: z.string() });
const HyperTableSchema = z.object({
  schema: z.string(),
  table: z.string(),
  columns: z.array(HyperColumnSchema),
  rowCount: z.number(),
});

export const inspectData = createTool({
  id: "inspectData",
  description:
    "Read the workbook's underlying extract (.hyper) and return an OVERVIEW of the " +
    "actual data: tables, their columns + SQL types, and row counts. Use this to " +
    "understand what data exists before profiling a field or writing a query. " +
    "READ-ONLY; the workbook is never modified.",
  inputSchema: z.object({ twbxPath: z.string() }),
  outputSchema: toolResult(
    z.object({
      tables: z.array(HyperTableSchema),
      primaryTable: z.string().optional(),
      totalRows: z.number(),
    }),
  ),
  execute: async (inputData) =>
    runTool(async () => {
      const tables = await listTables(inputData.twbxPath);
      const primary = primaryTable(tables);
      return {
        tables,
        primaryTable: primary?.table,
        totalRows: tables.reduce((s, t) => s + t.rowCount, 0),
      };
    }, "IO_ERROR"),
});

export const profileField = createTool({
  id: "profileField",
  description:
    "Profile a single field's ACTUAL values in the extract: non-null/null counts, " +
    "distinct count, min and max. For date fields it also returns the inclusive " +
    "YEAR range and the number of distinct years (use this to answer 'how many " +
    "years of data are present'). For numeric fields it returns sum and average. " +
    "READ-ONLY.",
  inputSchema: z.object({
    twbxPath: z.string(),
    field: z.string().describe("Field/column name, e.g. 'Order Date' or 'Sales'."),
    table: z
      .string()
      .optional()
      .describe("Table to read from; defaults to the primary (widest) table."),
  }),
  outputSchema: toolResult(
    z.object({
      field: z.string(),
      typeName: z.string(),
      isDate: z.boolean(),
      isNumeric: z.boolean(),
      nonNull: z.number(),
      nulls: z.number(),
      distinct: z.number(),
      min: z.string().nullable(),
      max: z.string().nullable(),
      years: z
        .object({ min: z.number(), max: z.number(), distinctCount: z.number() })
        .optional(),
      numeric: z.object({ sum: z.number(), avg: z.number() }).optional(),
    }),
  ),
  execute: async (inputData) =>
    runTool(
      () => profileColumn(inputData.twbxPath, inputData.field, inputData.table),
      "IO_ERROR",
    ),
});

export const queryData = createTool({
  id: "queryData",
  description:
    "Run a READ-ONLY SQL SELECT against the workbook's extract (.hyper) and return " +
    "capped rows. Use standard SQL; reference tables as \"schema\".\"table\" (get " +
    "exact names from inspectData) and columns by their real names in double " +
    "quotes, e.g. SELECT \"Region\", SUM(\"Sales\") FROM \"Extract\".\"Orders_...\" " +
    "GROUP BY \"Region\". Only a single SELECT/WITH statement is allowed; a LIMIT " +
    "is enforced. Never modifies the workbook.",
  inputSchema: z.object({
    twbxPath: z.string(),
    sql: z.string(),
    maxRows: z.number().int().positive().max(2000).optional(),
  }),
  outputSchema: toolResult(
    z.object({
      columns: z.array(z.string()),
      rows: z.array(z.array(z.string().nullable())),
      rowCount: z.number(),
      truncated: z.boolean(),
    }),
  ),
  execute: async (inputData) =>
    runTool(
      () => runReadOnlyQuery(inputData.twbxPath, inputData.sql, inputData.maxRows ?? 200),
      "IO_ERROR",
    ),
});

export const dataTools = {
  inspectData,
  profileField,
  queryData,
};
