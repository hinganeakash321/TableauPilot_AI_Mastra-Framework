import { describe, it, expect } from "vitest";
import {
  xmlEscape,
  insertBeforeLast,
  insertBeforeFirst,
  ensureSection,
  extractElement,
} from "../../src/tableau/xml.js";

describe("xml helpers", () => {
  it("escapes all XML-significant characters", () => {
    expect(xmlEscape(`Tom & "Jerry" <b> 'x'`)).toBe(
      "Tom &amp; &quot;Jerry&quot; &lt;b&gt; &apos;x&apos;",
    );
  });

  it("inserts before the last matching closing tag", () => {
    const xml = "<a><worksheets></worksheets></a>";
    const out = insertBeforeLast(xml, "</worksheets>", "<worksheet/>");
    expect(out).toBe("<a><worksheets><worksheet/></worksheets></a>");
  });

  it("inserts before the first matching closing tag", () => {
    const xml = "<w></x></x>";
    const out = insertBeforeFirst(xml, "</x>", "Y");
    expect(out).toBe("<w>Y</x></x>");
  });

  it("throws when the closing tag is missing", () => {
    expect(() => insertBeforeLast("<a></a>", "</zzz>", "x")).toThrow();
  });

  it("creates a section only when missing", () => {
    const withSection = "<workbook><worksheets></worksheets></workbook>";
    expect(ensureSection(withSection, "<worksheets>", "</worksheets>", "</workbook>")).toBe(
      withSection,
    );
    const without = "<workbook></workbook>";
    const out = ensureSection(without, "<windows>", "</windows>", "</workbook>");
    expect(out).toContain("<windows>");
    expect(out).toContain("</windows>");
    expect(out.indexOf("<windows>")).toBeLessThan(out.indexOf("</workbook>"));
  });

  it("extracts the first matching element", () => {
    const xml = `<x><datasource name='a'>A</datasource><datasource name='b'>B</datasource></x>`;
    const el = extractElement(xml, /<datasource\b/, "</datasource>");
    expect(el).toBe("<datasource name='a'>A</datasource>");
  });
});
