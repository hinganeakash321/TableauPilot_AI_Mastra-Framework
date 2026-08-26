# TableauPilot AI - Design

Detailed design decisions for the key subsystems.

## 1. Model layer (`src/mastra/models.ts`)

Requirements from `.env`: dynamic token (`ANTHROPIC_API_KEY_HELPER`), corporate
CA (`ANTHROPIC_CA_CERT`), gateway base URL, model name; OpenRouter fallback.

Design:
- `resolveAnthropicKey()`: returns `ANTHROPIC_API_KEY` if set, else executes
  `ANTHROPIC_API_KEY_HELPER` via `child_process.execFileSync` (parsed argv), trims
  output, caches in a module-level variable. `clearKeyCache()` clears it.
- `buildFetch()`: if `ANTHROPIC_CA_CERT` is set, read it and create an
  `undici.Agent({ connect: { ca } })`; return a `fetch` wrapper that (a) sets the
  dispatcher, (b) overrides the `x-api-key` / `authorization` header with the
  freshly resolved key, and (c) on `401` clears the cache and retries once.
- `getModel()`: builds provider once (memoized).
  - anthropic: `createAnthropic({ baseURL, apiKey: 'managed-by-fetch', fetch })('<model>')`.
  - openrouter: `createOpenAICompatible({ baseURL, apiKey, name:'openrouter' })('<model>')`.
- Never log token values. `logger.info` only reports provider + model + whether a
  CA / helper is in use.

## 2. Zod schemas (`src/mastra/schemas`)

All schemas are the runtime + type source of truth. Key shapes:

- `FieldInfo` / `FieldSpec`: name, caption, dataType (`string|integer|real|date|datetime|boolean`),
  role (`dimension|measure`), aggregation (`none|sum|avg|count|countd|min|max|median`),
  format?, sourceField?, calculation?.
- `ShelfSpec`: shelf (`rows|columns|color|size|label|detail|tooltip|path|shape|angle`),
  field ref + optional derivation/aggregation.
- `MarkSpec`: markType, encodings.
- `WorksheetFilterSpec`: field, operator (equals/in/contains/greater_than/between/...),
  values, or TopN (`{ field, n, byMeasure, direction }`).
- `WorksheetSpec`: name, datasourceName, chartType, rows[], columns[], marks[],
  filters[], calculations[], parameters[], formatting?, tooltip?.
- `WorksheetPlan`: `{ worksheets: WorksheetSpec[], lockedDatasource, notes? }`.
- `DatasourceLock`: workbookPath, datasourceName, datasourceId, connectionType,
  connectionMode (`live|extract`), locked (true).
- `ValidationResult`: `{ valid, errors[], warnings[] }`.
- `WorkbookBuildResult`, `DeploymentSpec`, `DeploymentResult` per spec.

`ChartType` enum lists all supported types (spec section 40). Unsupported ->
`UNSUPPORTED_CHART_TYPE`.

## 3. Column-instance naming (`compiler/columnInstance.ts`)

Deterministic mapping from `FieldSpec` + shelf usage to Tableau pill references.

```
buildColumnInstanceName(field): "[<deriv>:<Field>:<typekey>]"
buildPillRef(datasourceId, field): "[<datasourceId>].[<deriv>:<Field>:<typekey>]"
```

- deriv: measures -> aggregation code (`sum/avg/cnt/...`); date dimension with part
  -> `yr/qtr/mn/...`; plain dimension -> `none`.
- typekey: measure -> `qk`; date/ordinal -> `ok`; nominal dimension -> `nk`.

Also emits the `<datasource-dependencies>` `<column>` and `<column-instance>`
declarations required by each worksheet.

## 4. Chart builders (`compiler/charts/*`)

Each builder takes a normalized `WorksheetSpec` + locked datasource id and returns
a worksheet XML string modeled on the corresponding real template. Shared helper
assembles `<worksheet><table><view>...<panes>...<rows/><cols/></table></worksheet>`.

Chart family differences are captured as:
- mark class (`Bar`, `Line`, `Area`, `Automatic`, `Pie`, `Square`, `Circle`, ...).
- encodings (text/color/size/angle/shape) placement.
- rows/cols assignment and dual-axis handling.
- KPI: empty rows/cols, single measure on text with a customized label.
- Top N: adds a quantitative-rank/`top` groupfilter on the dimension by a measure.

A `registry` maps `ChartType -> builder + required shelves` so validation can tell
the user what a chart needs.

## 5. Worksheet & workbook compilation

- `worksheetCompiler.compile(spec, lock)` -> `{ worksheetXml, windowXml, dependencies }`.
- `workbookCompiler.applyChangePlan(twbXml, plan, lock)`:
  1. validate lock against the TWB datasource id.
  2. for each worksheet: check collision (existing name) -> respect
     `WorkbookChangePlan` intent (add / modify / new-version).
  3. insert `<worksheet>` blocks before `</worksheets>`.
  4. insert `<window class='worksheet'>` blocks before `</windows>`.
  5. return patched TWB string (datasource block untouched).

## 6. TWBX packaging (`twbx.ts`)

- `openTwbx(path)` -> `{ twbXml, entries }` where entries preserve original bytes.
- `writeTwbx(outPath, twbXml, entries)` -> zip with the (patched) `.twb` plus all
  original `Data/**` entries unchanged. Never rename `.twb` to `.twbx`.
- Enforces `workspace/{original,working,output}` layout.

## 7. Validators (`validators/*`)

- `validateTwbXml`: well-formed XML + required root/workbook elements.
- `validateDatasourceReferences`: all worksheet pill refs point to the locked ds id.
- `validateFieldExistence`: every referenced field exists in the datasource.
- `validateWorksheetReferences`: every `<window>` has a matching `<worksheet>`.
- `validateTwbxStructure`: zip has exactly one `.twb`, `Data/**` intact, parseable.
- Each returns `ValidationResult`.

## 8. Tableau Cloud service (`cloud/tableauCloudService.ts`)

REST (Tableau API version derived from `TABLEAU_VERSION`, e.g. `2026.1` -> API
`3.25`-ish; we send the site/auth XML/JSON per REST spec). Methods:
- `signIn({ serverUrl, siteContentUrl, patName, patSecret })` -> `{ token, siteId }`.
- `listProjects(session)` -> `Project[]` (paginated).
- `resolveProject(session, nameOrPath)` -> `Project`.
- `publishWorkbook(session, { filePath, name, projectId, overwrite })` -> ids.
- `verifyWorkbook(session, workbookId)` -> `{ webpageUrl, ... }`.
- `fetch` is injected (defaults to global) so tests mock it. Credentials are used
  transiently and never logged (redact in any error path).

## 9. Tools (`src/mastra/tools/*`)

Thin wrappers calling the engine. Pattern:

```ts
export const inspectWorkbook = createTool({
  id: 'inspectWorkbook',
  description: '...',
  inputSchema: z.object({ twbxPath: z.string() }),
  outputSchema: WorkbookInspectionResultSchema,
  execute: async (input) => engine.inspect(input.twbxPath),
});
```

High-impact tools add `requireApproval: true`.

## 10. Agent (`agents/tableauPilotAgent.ts`)

- `instructions`: encodes all invariants (rules.md section 3), scope refusals,
  structured-output requirement, and datasource-lock guard.
- `model`: `getModel()`.
- `tools`: all engine tools.
- `memory`: shared libSQL memory with working-memory template for workbook context.
- Structured output is requested per-call via `structuredOutput: { schema: WorksheetPlanSchema }`.

## 11. Memory (`memory/memory.ts`)

- `new Memory({ storage: libsql, options: { workingMemory: { enabled, template } } })`.
- Working memory template captures: current workbook path, locked datasource,
  current phase, last approved plan summary. Thread/resource keyed per workbook so
  context never leaks between unrelated TWBX files.

## 12. Processors (`processors/*`)

- `security.ts`: input + output processor that redacts secret-looking content.
- `context.ts`: ensures only metadata (not full TWB XML) reaches the model; trims
  oversized context.
- `validation.ts`: structural guards on inputs/outputs (e.g., reject prompts
  attempting datasource replacement early).

## 13. Workflows (`workflows/*`)

Deterministic sequences using `createStep` + `createWorkflow().then(...).commit()`.
`worksheetGeneration` and `deployment` call `suspend()` for human approval, resumed
via `resume()` with an approval payload. libSQL storage persists snapshots.

## 14. Mastra root (`mastra/index.ts`)

```ts
export const mastra = new Mastra({
  agents: { tableauPilotAgent },
  workflows: { workbookInspection, worksheetPlanning, worksheetGeneration, workbookBuild, deployment },
  storage: libsql,
  logger: new PinoLogger({ level }),
  observability: { /* enabled for Studio traces */ },
});
```
