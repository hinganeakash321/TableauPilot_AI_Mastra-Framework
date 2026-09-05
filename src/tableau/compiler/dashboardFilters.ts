/**
 * Apply-to-all-worksheets dashboard filter injection.
 *
 * Tableau's "Apply to Worksheets -> All Using This Data Source" is NOT stored on
 * the dashboard. Instead each filter field is written as a shared context filter
 * on EVERY worksheet that uses the datasource, tied together by a common
 * `filter-group` per field. This module injects those per-worksheet filters
 * (default select-all) plus any missing column / column-instance declarations,
 * using the same targeted string-insertion approach as the rest of the compiler.
 */

import type { DatasourceLock } from "../../mastra/schemas/datasource.js";
import type { ResolvedFilterField } from "./dashboardCompiler.js";

/** Result of an apply-to-all injection pass. */
export interface FilterInjectionResult {
  twbXml: string;
  /** Number of worksheets that received at least one new filter. */
  worksheetsInjected: number;
  /** filter-group number assigned to each field instance. */
  groupByInstance: Record<string, number>;
}

const DEPS_CLOSE = "</datasource-dependencies>";
const DS_CLOSE = "</datasources>";

/** Escapes a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A select-all context filter for one field, sharing `group` across worksheets so
 * Tableau treats it as a single dashboard-wide filter.
 */
function buildApplyToAllFilter(
  ff: ResolvedFilterField,
  group: number,
): string {
  return (
    `          <filter class='categorical' column='${ff.ref}' context='true' filter-group='${group}'>\n` +
    `            <groupfilter function='level-members' level='[${ff.instanceName}]' ` +
    `user:ui-enumeration='all' user:ui-marker='enumerate' />\n` +
    `          </filter>`
  );
}

/**
 * Finds the `</datasource-dependencies>` that closes the block for the LOCKED
 * datasource (`dsId`). A worksheet can have several dependency blocks (e.g. a
 * `Parameters` block for a parameter-driven Top-N plus the real datasource
 * block); we must target the real one, not whichever happens to be first.
 */
function lockedDepsCloseIndex(block: string, dsId: string): number {
  const openRe = new RegExp(
    `<datasource-dependencies datasource='${escapeRegExp(dsId)}'>`,
  );
  const openM = openRe.exec(block);
  if (!openM) return -1;
  return block.indexOf(DEPS_CLOSE, openM.index);
}

/**
 * Ensures the field's `<column>` and `<column-instance>` decls are present inside
 * the LOCKED datasource's `<datasource-dependencies>`, creating the section if
 * absent. Never writes into a foreign block (e.g. `Parameters`).
 */
function ensureDecls(
  block: string,
  dsId: string,
  ff: ResolvedFilterField,
): string {
  const needColumn = !block.includes(`name='[${ff.columnName}]'`);
  const needInstance = !block.includes(`name='[${ff.instanceName}]'`);
  const decls: string[] = [];
  if (needColumn) decls.push(ff.columnDecl);
  if (needInstance) decls.push(ff.columnInstanceDecl);
  // Co-declare source columns of derived fields (bins/groups/calcs) if absent.
  for (const srcDecl of ff.sourceColumnDecls) {
    const nameMatch = /name='(\[[^']*\])'/.exec(srcDecl);
    const already = nameMatch ? block.includes(`name='${nameMatch[1]}'`) : false;
    if (!already) decls.push(srcDecl);
  }
  if (decls.length === 0) return block;

  // Insert into the LOCKED datasource's deps block when it exists.
  const closeIdx = lockedDepsCloseIndex(block, dsId);
  if (closeIdx !== -1) {
    const insert = decls.map((d) => `${d}\n            `).join("");
    return block.slice(0, closeIdx) + insert + block.slice(closeIdx);
  }
  // No deps block for the locked datasource yet - create one. Place it after the
  // LAST existing deps block (so all `datasource-dependencies` stay grouped and
  // precede any `<filter>`), else right after `</datasources>`.
  const section =
    `\n          <datasource-dependencies datasource='${dsId}'>\n` +
    decls.map((d) => `            ${d}`).join("\n") +
    `\n          </datasource-dependencies>`;
  const lastDepsClose = block.lastIndexOf(DEPS_CLOSE);
  if (lastDepsClose !== -1) {
    const at = lastDepsClose + DEPS_CLOSE.length;
    return block.slice(0, at) + section + block.slice(at);
  }
  const dsIdx = block.indexOf(DS_CLOSE);
  if (dsIdx === -1) return block; // not a datasource worksheet; leave untouched
  const at = dsIdx + DS_CLOSE.length;
  return block.slice(0, at) + section + block.slice(at);
}

/** Transforms one worksheet block, adding any missing apply-to-all filters. */
function injectIntoWorksheet(
  block: string,
  dsId: string,
  filterFields: ResolvedFilterField[],
  groupByInstance: Record<string, number>,
): { block: string; injected: boolean } {
  // Only worksheets using the locked datasource participate.
  if (!block.includes(`name='${dsId}'`)) return { block, injected: false };

  let out = block;
  let injected = false;

  for (const ff of filterFields) {
    // Skip if a filter already targets this column instance on this sheet.
    const existing = new RegExp(`<filter[^>]*column='${escapeRegExp(ff.ref)}'`);
    if (existing.test(out)) continue;

    out = ensureDecls(out, dsId, ff);

    // Insert the filter after the LAST `</datasource-dependencies>` so every
    // dependency block (including a Parameters block) precedes the filters -
    // Tableau's content model requires datasource-dependencies* before filter.
    const lastClose = out.lastIndexOf(DEPS_CLOSE);
    if (lastClose === -1) continue; // couldn't establish a deps section
    const at = lastClose + DEPS_CLOSE.length;
    const filterXml = buildApplyToAllFilter(ff, groupByInstance[ff.instanceName]!);
    out = out.slice(0, at) + "\n" + filterXml + out.slice(at);
    injected = true;
  }

  return { block: out, injected };
}

/**
 * Injects apply-to-all context filters for every resolved field into every
 * worksheet that uses the locked datasource. filter-group numbers are assigned
 * above the current maximum in the TWB so they never collide with existing ones.
 */
export function injectApplyToAllFilters(
  twbXml: string,
  lock: DatasourceLock,
  filterFields: ResolvedFilterField[],
): FilterInjectionResult {
  if (filterFields.length === 0) {
    return { twbXml, worksheetsInjected: 0, groupByInstance: {} };
  }
  const dsId = lock.datasourceId;

  // Base filter-group above any existing group so we don't clash.
  let maxGroup = 0;
  for (const m of twbXml.matchAll(/filter-group='(\d+)'/g)) {
    const n = Number(m[1]);
    if (n > maxGroup) maxGroup = n;
  }
  const groupByInstance: Record<string, number> = {};
  // De-dup fields by instance so the same field shares one group everywhere.
  const uniqueFields: ResolvedFilterField[] = [];
  const seen = new Set<string>();
  for (const ff of filterFields) {
    if (seen.has(ff.instanceName)) continue;
    seen.add(ff.instanceName);
    uniqueFields.push(ff);
    groupByInstance[ff.instanceName] = maxGroup + uniqueFields.length;
  }

  let worksheetsInjected = 0;
  const twb = twbXml.replace(
    /<worksheet\b[^>]*>[\s\S]*?<\/worksheet>/g,
    (block) => {
      const res = injectIntoWorksheet(block, dsId, uniqueFields, groupByInstance);
      if (res.injected) worksheetsInjected += 1;
      return res.block;
    },
  );

  return { twbXml: twb, worksheetsInjected, groupByInstance };
}
