/**
 * XML utilities for the Tableau engine.
 *
 * Two concerns:
 *  1. Read-only parsing (via fast-xml-parser) for inspection.
 *  2. Safe, targeted string insertion for modifications - we deliberately avoid
 *     full re-serialization so the locked datasource block and all existing
 *     formatting are preserved byte-for-byte (spec sections 36, 39, design.md).
 */

import { XMLParser } from "fast-xml-parser";

/** Escapes a string for use inside XML text or single-quoted attributes. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
}

/** Shared parser configured to keep attributes and not coerce values. */
export function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    // Tableau XML has repeated elements; ensure arrays are predictable via helper.
    isArray: () => false,
  });
}

/** Parses TWB XML into a plain object for read-only inspection. */
export function parseXml(xml: string): Record<string, unknown> {
  const parser = createParser();
  return parser.parse(xml) as Record<string, unknown>;
}

/** Ensures a parsed node is returned as an array (fast-xml-parser quirk). */
export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Inserts `content` immediately before the LAST occurrence of `closingTag`
 * (e.g. `</worksheets>`). Returns the modified XML. Throws if the tag is absent.
 */
export function insertBeforeLast(
  xml: string,
  closingTag: string,
  content: string,
): string {
  const idx = xml.lastIndexOf(closingTag);
  if (idx === -1) {
    throw new Error(`Cannot insert: closing tag ${closingTag} not found`);
  }
  return xml.slice(0, idx) + content + xml.slice(idx);
}

/**
 * Inserts `content` immediately before the FIRST occurrence of `closingTag`.
 */
export function insertBeforeFirst(
  xml: string,
  closingTag: string,
  content: string,
): string {
  const idx = xml.indexOf(closingTag);
  if (idx === -1) {
    throw new Error(`Cannot insert: closing tag ${closingTag} not found`);
  }
  return xml.slice(0, idx) + content + xml.slice(idx);
}

/**
 * Ensures a container section exists (e.g. `<worksheets>...</worksheets>`). If
 * the closing tag is missing, the section is created right before `anchorClose`
 * (typically `</workbook>`). Returns possibly-modified XML.
 */
export function ensureSection(
  xml: string,
  openTag: string,
  closeTag: string,
  anchorClose: string,
): string {
  if (xml.includes(closeTag)) return xml;
  const section = `  ${openTag}\n  ${closeTag}\n`;
  return insertBeforeLast(xml, anchorClose, section);
}

/** Extracts the raw substring of the first element matching an open/close pair. */
export function extractElement(
  xml: string,
  openPattern: RegExp,
  closeTag: string,
): string | null {
  const openMatch = openPattern.exec(xml);
  if (!openMatch) return null;
  const start = openMatch.index;
  const end = xml.indexOf(closeTag, start);
  if (end === -1) return null;
  return xml.slice(start, end + closeTag.length);
}
