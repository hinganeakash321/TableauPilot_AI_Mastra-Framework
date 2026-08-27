/**
 * Read-only access to the underlying data inside a TWBX's `.hyper` extract.
 *
 * Uses Tableau's official Rust-backed Node bindings (`hyperdb-api-node`) - NO
 * Python. The extract is copied to a temp file and opened read-only (DoNotCreate);
 * the workbook's `.hyper` is never modified. This powers questions like "how many
 * years of data are present", column profiles, row counts, and small data previews.
 *
 * Requires the `hyperd` server binary. We locate it via (in order):
 *   1. the HYPERD_PATH env var,
 *   2. an installed Tableau Desktop / Prep app bundle,
 *   3. a `tableauhyperapi` Python package install,
 *   4. the `hyperdb-api-node` platform package (getHyperdPath()).
 */

import { createRequire } from "node:module";
import { readdirSync, existsSync } from "node:fs";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTwbx } from "../twbx.js";
import { PROJECT_ROOT } from "../paths.js";

const require = createRequire(import.meta.url);

/** Native module surface we use (the const enums are compile-time only). */
interface HyperNative {
  HyperProcess: new (hyperdPath?: string) => {
    endpoint: string;
    close(): void;
  };
  Connection: {
    connect(
      endpoint: string,
      databasePath: string,
      createMode: string,
    ): Promise<HyperConnection>;
  };
  Catalog: new (conn: HyperConnection) => {
    getSchemaNames(): Promise<string[]>;
    getTableNames(schema: string): Promise<string[]>;
  };
  getHyperdPath?: () => string | null;
}

interface HyperRow {
  columnCount: number;
  isNull(i: number): boolean;
  getString(i: number): string | null;
}

interface HyperConnection {
  executeQuery(sql: string): Promise<HyperRow[]>;
  querySchema(sql: string): Promise<{ name: string; typeName: string; index: number }[]>;
  close(): Promise<void>;
}

let cachedNative: HyperNative | null = null;
function loadNative(): HyperNative {
  if (cachedNative) return cachedNative;
  cachedNative = require("hyperdb-api-node") as HyperNative;
  return cachedNative;
}

/** Lists directory entries safely (returns [] if the dir is missing). */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

let cachedHyperd: string | null | undefined;

/** Locates a usable `hyperd` executable, or returns null if none is found. */
export function resolveHyperdPath(): string | null {
  if (cachedHyperd !== undefined) return cachedHyperd;

  const candidates: string[] = [];
  const fromEnv = process.env.HYPERD_PATH?.trim();
  if (fromEnv) candidates.push(fromEnv);

  // Project-local bundle, created by `npm run hyperd:setup` (scripts/download-hyperd.mjs).
  // This is what makes the data-reading feature portable to servers/containers that
  // do NOT have Tableau installed. The extracted `lib/hyper/` layout is kept intact.
  const exe = process.platform === "win32" ? "hyperd.exe" : "hyperd";
  candidates.push(
    join(PROJECT_ROOT, ".hyperd", "hyper", exe),
    join(PROJECT_ROOT, ".hyperd", "current", exe),
    join(PROJECT_ROOT, ".hyperd", exe),
  );

  // Tableau Desktop / Prep app bundles on macOS. Prefer newer versions.
  const apps = safeReaddir("/Applications")
    .filter((n) => /^Tableau (Desktop|Prep)/i.test(n))
    .sort()
    .reverse();
  for (const app of apps) {
    candidates.push(
      join("/Applications", app, "Contents/MacOS/hyper/hyperd"),
      join("/Applications", app, "Contents/Resources/app/tableau-1.3/build/Release/hyper/hyperd"),
    );
  }

  // tableauhyperapi Python package (bundles hyperd).
  const home = process.env.HOME;
  if (home) {
    const pyRoot = join(home, "Library/Python");
    for (const ver of safeReaddir(pyRoot)) {
      candidates.push(
        join(pyRoot, ver, "lib/python/site-packages/tableauhyperapi/bin/hyper/hyperd"),
      );
    }
  }

  // hyperdb-api-node platform package, if it shipped a hyperd.
  try {
    const native = loadNative();
    const fromPkg = native.getHyperdPath?.();
    if (fromPkg) candidates.push(fromPkg);
  } catch {
    // native addon not loadable - fall through to other candidates.
  }

  for (const c of candidates) {
    if (c && existsSync(c)) {
      cachedHyperd = c;
      return c;
    }
  }
  cachedHyperd = null;
  return null;
}

/** Thrown when the hyperd binary cannot be located. */
export class HyperdNotFoundError extends Error {
  constructor() {
    super(
      "Could not locate the 'hyperd' server binary required to read extract data. " +
        "Set HYPERD_PATH to a hyperd executable (Tableau Desktop bundles one under " +
        "<App>/Contents/MacOS/hyper/hyperd).",
    );
    this.name = "HyperdNotFoundError";
  }
}

/** Quotes a SQL identifier (schema/table/column). */
function q(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

export interface HyperColumn {
  name: string;
  typeName: string;
}

export interface HyperTable {
  schema: string;
  table: string;
  columns: HyperColumn[];
  rowCount: number;
}

export interface HyperConnHandle {
  conn: HyperConnection;
  q: (id: string) => string;
}

/**
 * Extracts the `.hyper` from a TWBX to a temp file and runs `fn` with an open
 * read-only connection. Cleans up the process, connection, and temp file.
 */
export async function withHyperFromTwbx<T>(
  twbxPath: string,
  fn: (h: HyperConnHandle) => Promise<T>,
): Promise<T> {
  const hyperdPath = resolveHyperdPath();
  if (!hyperdPath) throw new HyperdNotFoundError();

  const { entries } = await openTwbx(twbxPath);
  const hyperEntry = entries.find((e) => e.path.toLowerCase().endsWith(".hyper"));
  if (!hyperEntry) {
    throw new Error("This workbook has no .hyper extract to read (it may be live-only).");
  }

  const native = loadNative();
  const dir = await mkdtemp(join(tmpdir(), "tp-hyper-"));
  const hp = join(dir, "extract.hyper");
  await writeFile(hp, hyperEntry.data);

  const process = new native.HyperProcess(hyperdPath);
  let conn: HyperConnection | null = null;
  try {
    conn = await native.Connection.connect(process.endpoint, hp, "DoNotCreate");
    return await fn({ conn, q });
  } finally {
    try {
      await conn?.close();
    } catch {
      /* ignore */
    }
    try {
      process.close();
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "public"]);

/** Lists all user tables in the extract with their columns and row counts. */
export async function listTables(twbxPath: string): Promise<HyperTable[]> {
  return withHyperFromTwbx(twbxPath, async ({ conn }) => {
    const native = loadNative();
    const cat = new native.Catalog(conn);
    const schemas = await cat.getSchemaNames();
    const out: HyperTable[] = [];
    for (const schema of schemas) {
      if (SYSTEM_SCHEMAS.has(schema.toLowerCase())) continue;
      const tables = await cat.getTableNames(schema);
      for (const table of tables) {
        const cols = await conn.querySchema(
          `SELECT * FROM ${q(schema)}.${q(table)} LIMIT 0`,
        );
        const rc = await conn.executeQuery(
          `SELECT COUNT(*) FROM ${q(schema)}.${q(table)}`,
        );
        out.push({
          schema,
          table,
          columns: cols.map((c) => ({ name: c.name, typeName: c.typeName })),
          rowCount: Number(rc[0]?.getString(0) ?? 0),
        });
      }
    }
    return out;
  });
}

/** Chooses the primary fact table (the one with the most columns). */
export function primaryTable(tables: HyperTable[]): HyperTable | undefined {
  return [...tables].sort((a, b) => b.columns.length - a.columns.length)[0];
}

export interface ColumnProfile {
  field: string;
  typeName: string;
  isDate: boolean;
  isNumeric: boolean;
  nonNull: number;
  nulls: number;
  distinct: number;
  min: string | null;
  max: string | null;
  /** For date/datetime columns: inclusive year range + distinct year count. */
  years?: { min: number; max: number; distinctCount: number };
  /** For numeric columns: sum and average. */
  numeric?: { sum: number; avg: number };
}

/** Profiles a single column (min/max/distinct/nulls, plus year range for dates). */
export async function profileColumn(
  twbxPath: string,
  field: string,
  tableName?: string,
): Promise<ColumnProfile> {
  const tables = await listTables(twbxPath);
  const target =
    (tableName
      ? tables.find((t) => t.table === tableName)
      : undefined) ?? primaryTable(tables);
  if (!target) throw new Error("No data tables found in the extract.");

  const col = target.columns.find(
    (c) => c.name.toLowerCase() === field.toLowerCase(),
  );
  if (!col) {
    throw new Error(
      `Field '${field}' not found in table '${target.table}'. ` +
        `Available: ${target.columns.map((c) => c.name).join(", ")}`,
    );
  }

  const t = col.typeName.toUpperCase();
  const isDate = /DATE|TIMESTAMP/.test(t);
  const isNumeric = /INT|DOUBLE|NUMERIC|DECIMAL|REAL|FLOAT/.test(t);

  return withHyperFromTwbx(twbxPath, async ({ conn }) => {
    const from = `${q(target.schema)}.${q(target.table)}`;
    const c = q(col.name);
    const base = await conn.executeQuery(
      `SELECT COUNT(${c}) AS non_null, COUNT(*) - COUNT(${c}) AS nulls, ` +
        `COUNT(DISTINCT ${c}) AS distinct_ct, ` +
        `CAST(MIN(${c}) AS TEXT) AS min_v, CAST(MAX(${c}) AS TEXT) AS max_v FROM ${from}`,
    );
    const row = base[0]!;
    const profile: ColumnProfile = {
      field: col.name,
      typeName: col.typeName,
      isDate,
      isNumeric,
      nonNull: Number(row.getString(0) ?? 0),
      nulls: Number(row.getString(1) ?? 0),
      distinct: Number(row.getString(2) ?? 0),
      min: row.getString(3),
      max: row.getString(4),
    };

    if (isDate) {
      const y = await conn.executeQuery(
        `SELECT MIN(EXTRACT(YEAR FROM ${c})), MAX(EXTRACT(YEAR FROM ${c})), ` +
          `COUNT(DISTINCT EXTRACT(YEAR FROM ${c})) FROM ${from} WHERE ${c} IS NOT NULL`,
      );
      const yr = y[0]!;
      if (yr.getString(0) != null) {
        profile.years = {
          min: Number(yr.getString(0)),
          max: Number(yr.getString(1)),
          distinctCount: Number(yr.getString(2)),
        };
      }
    }
    if (isNumeric) {
      const n = await conn.executeQuery(
        `SELECT CAST(SUM(${c}) AS DOUBLE PRECISION), CAST(AVG(${c}) AS DOUBLE PRECISION) FROM ${from}`,
      );
      const nr = n[0]!;
      if (nr.getString(0) != null) {
        profile.numeric = { sum: Number(nr.getString(0)), avg: Number(nr.getString(1)) };
      }
    }
    return profile;
  });
}

export interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  truncated: boolean;
}

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|COPY|CALL|MERGE|TRUNCATE|GRANT|REVOKE|SET)\b/i;

/**
 * Runs a READ-ONLY SELECT against the extract and returns capped rows as strings.
 * Rejects anything that is not a single SELECT. A LIMIT is enforced.
 */
export async function runReadOnlyQuery(
  twbxPath: string,
  sql: string,
  maxRows = 200,
): Promise<QueryResult> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(trimmed) && !/^with\b/i.test(trimmed)) {
    throw new Error("Only read-only SELECT queries are allowed.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed (no ';').");
  }
  if (FORBIDDEN_SQL.test(trimmed)) {
    throw new Error("Query contains a forbidden (write/DDL) keyword.");
  }

  const cap = Math.max(1, Math.min(maxRows, 2000));
  const wrapped = `SELECT * FROM (${trimmed}) AS _tp_sub LIMIT ${cap + 1}`;

  return withHyperFromTwbx(twbxPath, async ({ conn }) => {
    const schema = await conn.querySchema(wrapped);
    const columns = schema.map((c) => c.name);
    const result = await conn.executeQuery(wrapped);
    const truncated = result.length > cap;
    const rows = result.slice(0, cap).map((r) => {
      const vals: (string | null)[] = [];
      for (let i = 0; i < columns.length; i += 1) {
        vals.push(r.isNull(i) ? null : r.getString(i));
      }
      return vals;
    });
    return { columns, rows, rowCount: rows.length, truncated };
  });
}
