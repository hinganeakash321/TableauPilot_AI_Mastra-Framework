import { openTwbx } from "../src/tableau/twbx.js";
import { inspectTwbXml } from "../src/tableau/twb.js";
import { validateGeneratedTwb, validateTwbxStructure } from "../src/tableau/validators/index.js";
import type { DatasourceLock } from "../src/mastra/schemas/datasource.js";

const opened = await openTwbx("./workspace/output/sample_generated.twbx");
const info = inspectTwbXml(opened.twbXml, "sample_generated.twbx");
const ds = info.datasources[0]!;
const lock: DatasourceLock = {
  workbookPath: "./workspace/output/sample_generated.twbx",
  datasourceName: ds.caption ?? ds.name,
  datasourceId: ds.id,
  connectionType: ds.connectionType,
  connectionMode: ds.connectionMode,
  locked: true,
};

const structure = validateTwbxStructure(opened);
console.log("structure:", JSON.stringify(structure));
const generated = [
  "TP Monthly Sales Trend",
  "TP Sales by Region",
  "TP Top 10 Customers",
  "TP Total Sales KPI",
];
const twb = validateGeneratedTwb(opened.twbXml, lock, info.fields, generated);
console.log("twb valid:", twb.valid);
console.log("errors:", JSON.stringify(twb.errors, null, 2));
console.log("warnings:", JSON.stringify(twb.warnings));
