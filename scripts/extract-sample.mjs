/**
 * One-off extraction: reads sample_workbook.twbx and writes the real worksheet
 * XML blocks + datasource block into templates/sample-1/ as reference material
 * for the deterministic compiler. These are REAL Tableau patterns (spec 38/39).
 *
 * Run: node scripts/extract-sample.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import JSZip from "jszip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const twbxPath = join(root, "sample_workbook.twbx");
const outDir = join(root, "templates", "sample-1");
mkdirSync(outDir, { recursive: true });

const zip = await JSZip.loadAsync(readFileSync(twbxPath));
const twbEntry = Object.keys(zip.files).find((f) => f.endsWith(".twb"));
if (!twbEntry) throw new Error("No .twb found in TWBX");
const twb = await zip.files[twbEntry].async("string");

function sanitize(name) {
  return name.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

// Extract each worksheet block.
const wsRegex = /<worksheet name='([^']*)'>[\s\S]*?<\/worksheet>/g;
const manifest = [];
let m;
while ((m = wsRegex.exec(twb)) !== null) {
  const name = m[1];
  const block = m[0];
  const file = `ws_${sanitize(name)}.xml`;
  writeFileSync(join(outDir, file), block, "utf8");
  manifest.push({ name, file, length: block.length });
}

// Extract the datasource block (first real datasource under <datasources>).
const dsMatch = twb.match(
  /<datasource caption='[^']*' inline='true'[\s\S]*?<\/datasource>/,
);
if (dsMatch) {
  writeFileSync(join(outDir, "datasource.xml"), dsMatch[0], "utf8");
}

// Extract a couple of <window> blocks for reference.
const winRegex = /<window class='worksheet'[^>]*>[\s\S]*?<\/window>/g;
let win;
const windows = [];
while ((win = winRegex.exec(twb)) !== null && windows.length < 3) {
  windows.push(win[0]);
}
writeFileSync(join(outDir, "windows-sample.xml"), windows.join("\n\n"), "utf8");

writeFileSync(
  join(outDir, "manifest.json"),
  JSON.stringify({ source: "sample_workbook.twbx", worksheets: manifest }, null, 2),
  "utf8",
);

console.log(`Extracted ${manifest.length} worksheets to ${outDir}`);
