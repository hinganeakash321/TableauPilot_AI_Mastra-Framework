# TableauPilot AI - Working Memory (Build Progress)

> Living document. Tracks what is complete, in-progress, and next.
> Update as files are created/changed.

## Environment facts (verified)

- Node: v26.7.0, npm 11.19.0.
- Installed (pinned, stable versions available in this environment):
  - `@mastra/core@1.59.0`, `mastra@1.25.0`, `@mastra/memory@1.26.2`,
    `@mastra/libsql@1.20.0`, `@mastra/evals@1.7.0`, `@mastra/loggers@1.2.0`
  - `@ai-sdk/anthropic@3.0.111`, `@ai-sdk/openai-compatible@3.0.31`, `ai@5.0.237`
  - `zod@^3.25`, `fast-xml-parser@^5`, `jszip@^3.10`, `undici@^7`, `vitest@^3`
- Confirmed Mastra v1 APIs:
  - Tools: `createTool({ id, description, inputSchema, outputSchema, requireApproval?, execute:(inputData, ctx)=>... })`
  - Steps: `createStep({ id, inputSchema, outputSchema, resumeSchema?, suspendSchema?, execute:({ inputData, resumeData, suspend, mastra, ... })=>... })`
  - `createWorkflow`, `Workflow`, `Agent`, `Mastra`, `Memory`, `LibSQLStore`,
    `createAnthropic`, `createOpenAICompatible`, `PinoLogger`.
  - Processors base: `BaseProcessor` (plus built-ins: PIIDetector,
    PromptInjectionDetector, UnicodeNormalizer, etc.).
- `.env` auth: `ANTHROPIC_API_KEY_HELPER` returns a short-lived token (verified,
  masked). `ANTHROPIC_CA_CERT` present. Gateway base URL present. Model
  `claude-sonnet-4-6`. `OPENROUTER_API_KEY` fallback present. `TABLEAU_VERSION=2026.1`.
- Sample workbook: `sample_workbook.twbx` (Tableau 2026.1, XML v18.1), single
  Excel->Hyper datasource `Orders+ (Sample - APAC Superstore)`
  (`federated.10qdv2g11ishnn1d8ylfn1hvu2ys`), 20 worksheets (all major chart types),
  has `<worksheets>` and `<windows>` sections; column-instance naming rule confirmed.

## Status by phase

| Phase | Status | Notes |
|-------|--------|-------|
| 0 - Setup | DONE | package.json, tsconfig, .gitignore, .env.example, dirs, deps installed, esbuild fixed |
| 0b - Planning docs | DONE | prd.md, architecture.md, rules.md, phases.md, design.md, memory.md |
| 1 - Config & model | DONE | logger.ts, env.ts (Zod-validated), models.ts (gateway + key-helper + CA + OpenRouter fallback) |
| 2 - Schemas | DONE | common/datasource/workbook/worksheet/deployment + barrel |
| 3 - Sample analysis & templates | DONE | sample_workbook_analysis.md, templates/sample-1, templates/registry |
| 4 - Engine inspection | DONE | twbx.ts, xml.ts, twb.ts, inspect.ts, lock.ts |
| 5 - Compiler | DONE | columnInstance, worksheetCompiler, workbookCompiler |
| 6 - Validators | DONE | validators/index.ts (scoped field validation) |
| 7 - Cloud service | DONE | cloud/tableauCloudService.ts (injectable fetch) |
| 8 - Tools | DONE | workbook/datasource/worksheet/build/deployment tools + _shared |
| 9 - Agent/memory/processors | DONE | tableauPilotAgent (lazy model), memory (libsql), processors (security/context/validation) |
| 10 - Workflows | DONE | inspection, planning, generation (HITL), build, deployment (2x HITL) |
| 11 - Mastra root & Studio | DONE | src/mastra/index.ts; `npm run dev` -> Studio at :4111; agent + 5 workflows discovered; observability via MastraStorageExporter + SensitiveDataFilter |
| 12 - Tests & evals | DONE | 10 files / 39 tests passing (unit + integration + evals), externals mocked |
| 13 - Docs (README + python decision) | DONE | README.md, docs/python-dependency-decision.md |

## Status

- **Build complete.** `npm run typecheck` clean; `npm test` = 39 passing; `npm run dev`
  boots Studio with the agent and all five workflows registered.

## Open decisions / notes

- **File intake:** `.twbx` is binary and must never be pasted into chat. Users upload
  via `GET/POST /upload` (drag-and-drop page) or drop into `uploads/`. `listWorkbooks`
  tool + `resolveWorkbookPath` (src/tableau/paths.ts) let the agent reference files by
  bare filename. Uploads anchored to project root (dev server CWD differs).
- **Model/gateway fix:** AI SDK posts to `${baseURL}/messages`; `normalizeAnthropicBaseUrl`
  must ENSURE a trailing `/v1` (not strip it). Verified generate+stream via gateway.
- XML writes use targeted string insertion (not full re-serialization) to keep the
  locked datasource + `.hyper` byte-for-byte intact.
- Chart coverage limited to types with real templates in the sample workbook.
- Python: NOT introduced. See `docs/python-dependency-decision.md`. Reading extract
  data uses Tableau's official **Rust-backed Node** bindings (`hyperdb-api-node`), not
  Python.
- **Calculated fields (creation):** `src/tableau/compiler/calculatedFields.ts` writes
  `<column caption=..><calculation class='tableau' formula=..></column>` into the LOCKED
  datasource (connection/extract untouched). Wired through `applyWorksheets` /
  `compileWorkbook` (top-level `calculations` + each spec's `calculations`); existing
  fields with the same name are reused, not duplicated. New calc `FieldInfo`s are merged
  into the field index (`effectiveFields`) so worksheets + validation resolve references
  by name. Agent references the calc on shelves by the name it assigned.
- **Context filters:** `WorksheetFilterSpec.context: true` -> compiler emits
  `context='true'` on the `<filter>` (categorical/quantitative/topN). Applied before
  other dimension/Top-N filters (Tableau order of operations).
- **Reading underlying data:** `src/tableau/data/hyperReader.ts` opens the TWBX's
  `.hyper` READ-ONLY (temp copy) and exposes `listTables` / `profileColumn` /
  `runReadOnlyQuery`. Surfaced to the agent as `inspectData`, `profileField` (returns
  year range + distinct-year count for dates -> answers "how many years of data"),
  and `queryData` (single READ-ONLY SELECT, LIMIT enforced). `hyperd` is auto-located
  (HYPERD_PATH env, else Tableau Desktop/Prep app bundle, else tableauhyperapi, else
  the platform package). Node >= 21 required (native napi addon).
- **hyperd bootstrap (deploy portability):** `scripts/download-hyperd.mjs`
  (`npm run hyperd:setup`) downloads the pinned, platform-correct `hyperd` from
  Tableau's Hyper API **Java** zip (`downloads.tableau.com/.../tableauhyperapi-java-<slug>-release-main.<ver>.<build>.zip`),
  extracts `lib/hyper/**` into `./.hyperd/hyper/` (via jszip, no unzip CLI). The reader
  auto-detects `./.hyperd/hyper/hyperd` (2nd priority, after HYPERD_PATH). `Dockerfile`
  + `.dockerignore` bundle it for clean hosts (no Tableau). `.hyperd/` is gitignored.
  Verified: bundled 260 MB self-contained hyperd queries the sample (years 2023-2026).
- Deployment workflow takes PAT at the resume step (used transiently, never persisted
  to workflow state); only an opaque session handle flows between steps.
- Workflow `suspendPayload` is keyed by step id (e.g. `suspendPayload.generateWorksheets`).
- Added dependency this phase: `@mastra/observability@^1.17.0`.
- **Dashboards (build + modify):** `DashboardSpec` (`src/mastra/schemas/dashboard.ts`) ->
  `dashboardCompiler.compileDashboard` emits sample-faithful dashboard XML (style
  `#e6e6e6`, `#ffffff` chart containers, `automatic`/`fixed` sizing, title band, chart
  grid rows, right Filters panel with `checkdropdown` + `show-apply='true'` +
  `values='relevant'`/date=`database`, zone tree in 0-100000 with only title/panel
  `is-fixed`, window + a `<viewpoint>` per sheet). Coordinates are consistently tiled;
  Tableau reflows flow zones on open, and `<devicelayout>`/`<layout-cache>` are omitted
  (regenerated). "Apply to all worksheets" is NOT on the dashboard: `dashboardFilters.
  injectApplyToAllFilters` writes a shared `filter-group` context filter (default
  select-all `user:ui-enumeration='all'`) + the field's column/column-instance decls
  into EVERY worksheet using the locked datasource. Wired via
  `workbookCompiler.applyDashboards` (+ `existingDashboardNames`/replace-by-name for
  modify) and threaded through `build.ts` (`dashboards?` on `compileWorkbookToWorking`/
  `buildWorkbook`, applied AFTER worksheets). Tools: `createDashboard` / `modifyDashboard`
  (`src/mastra/tools/dashboardTools.ts`, no separate approval - working TWBX is the
  deliverable). Validation: `validateDashboardReferences` (zones + viewpoints reference
  real worksheets). Samples extracted to `templates/sample-1/dash_*.xml` +
  `win_dash_*.xml`; patterns documented in `sample_dashboard_analysis.md`. Tests:
  `tests/evals/dashboard-eval.test.ts` (compile + injection + end-to-end build). Agent
  instructions gained a Dashboards section (invariant #5 now permits dashboards).
- **Datasource-id resolution fix:** the re-saved sample workbook lists the special
  `<datasource name='Parameters'>` FIRST; `getWorkbookDatasourceId` now skips
  `Parameters` and returns the real data datasource (also repaired two pre-existing
  worksheet-eval failures).
- **Full-dashboard flow (verified):** `createDashboard` accepts `specs` (new charts)
  AND `dashboards` in one call - `compileWorkbookToWorking` builds the worksheets
  first, then the dashboard that references them, then validates (single approval,
  no packaging). Agent instructions gained a "FULL DASHBOARD REQUEST" recipe (plan
  all charts + the board -> one approval -> one createDashboard call -> Download).
  Modify/redesign = `modifyDashboard` (or same-name `createDashboard`) replaces the
  dashboard by name (add/remove sheets, switch automatic<->fixed, change filters)
  without duplicating it. Covered by 2 new evals (one-pass build; modify/redesign).
  Full suite: 62 tests passing, typecheck clean.
- **Dashboard load fixes (from opening generated TWBX):**
  1. `enable-sort-zone-taborder` on `<dashboard>` is rejected by some Tableau
     versions -> our compiler emits a plain `<dashboard name=...>` AND
     `applyDashboards` strips the attribute from any pass-through dashboard.
  2. Multi-pill shelves were bare-concatenated (`[a][b]`) -> "unable to associate
     operators with operands". `buildShelf` now joins pills as a real expression:
     discrete `([a] / [b])`, continuous `([m1] + [m2])`, single pill bare (matches
     sample side-by-side/dual charts). Added multi-pill evals. Full suite: 65 tests.
- **Aggregated calc fields -> AGG(field):** a calc whose formula already contains a
  top-level aggregate (SUM/AVG/COUNT/COUNTD/MIN/MAX/MEDIAN/ATTR/STDEV/VAR/...) is an
  aggregate measure and must NOT be re-aggregated. `isAggregateFormula`
  (`compiler/columnInstance.ts`) detects this (LOD `{FIXED ...}` inner aggregates and
  string literals are ignored). `FieldInfo.aggregated` is set both when creating calcs
  (`calculatedFields.ts`) and when inspecting existing ones (`twb.ts`). Such pills
  resolve to `derivation='User'` / `[usr:<name>:qk]` (Tableau `AGG(field)`) instead of
  `[sum:...]`; `toPillInput`/`resolvePill` honor the flag (it wins over any aggregation).
  Row-level calcs (`[Profit]/[Sales]`) still default to SUM. Agent instructions updated;
  4 new evals added. Full suite: 68 tests passing, typecheck clean.
- **Five new Tableau features (colors, ref lines, totals, discrete/continuous,
  parameters, dashboard actions)** - all modeled on the sample workbook's XML:
  1. **Discrete<->continuous:** `FieldSpec.continuous` (schema) -> `PillInput.continuous`
     -> `resolvePill` (`columnInstance.ts`). `false` = discrete (measures `ordinal`/`ok`;
     date parts `yr:..:ok`), `true` = continuous (date trunc `tmn:..:qk` `Month-Trunc`;
     numeric dim `qk`). Overrides the chart-family default.
  2. **Chart colors:** `FieldSpec.colors` = `[{value,color:#hex}]` on a COLOR-shelf
     dimension -> pane `<style-rule element='mark'><encoding attr='color'
     field='[none:X:nk]' type='palette'><map to='#hex'><bucket>&quot;member&quot;</bucket>`
     (`buildColorEncodings` in `worksheetCompiler.ts`). Measure-on-color = Tableau's
     automatic gradient (just place on the color shelf). `HexColorSchema` in `common.ts`.
  3. **Reference/average lines:** `WorksheetSpec.referenceLines`
     (`{field,formula,scope,value?}`) -> `<reference-line formula='average'
     value-column='[..sum:Sales:qk]' scope='per-table' .../>` under the pane
     (`buildReferenceLines`). Aggregate formulas map min->minimum/max->maximum; constant
     uses `value=`.
  4. **Grand totals:** `WorksheetSpec.grandTotals` `{row,column}` -> `total='true'` on the
     `<rows>`/`<cols>` shelves (`assembleWorksheet` rowsTotal/colsTotal).
  5. **Parameters:** new `compiler/parameters.ts` writes `<datasource name='Parameters'>`
     `<column ... param-domain-type='any'>` (creates the ds if missing; reuses by caption;
     `parseExistingParameterColumns` reads the sample's "Top N"). `TopN.nParameter` ->
     Top-N filter `count='[Parameters].[Parameter N]'` + a worksheet
     `<datasource-dependencies datasource='Parameters'>` + `<datasource name='Parameters'/>`
     (threaded `compileWorksheet(...,params)` -> `buildFilters` -> `assembleWorksheet`).
     Wired through `applyWorksheets` (ApplyOptions.parameters, ApplyResult.parametersAdded),
     `build.ts`, and the `compileWorkbook` tool (`parameters` in/`parametersAdded` out).
     `validateFieldExistence` now scans ALL dependency blocks and SKIPS `datasource=
     'Parameters'` (params aren't data fields).
     - **Parameter control on a dashboard** (Sep 2026): `DashboardFiltersSpec.parameters`
       (array of param display names) renders each as a `type-v2='paramctrl'` zone in the
       filters panel (mode: any->`type_in`, list->`dropdown`, range->`slider`), modeled on
       the sample's `<zone ... param='[Parameters].[Parameter 1]' type-v2='paramctrl'>`.
       `compileDashboard` takes a `parameterColumns` arg; `applyDashboards` supplies it via
       `parseExistingParameterColumns(out)`. Unknown param name -> compile error. Agent now
       ALWAYS asks (on any Top/Bottom N request) whether to use a live parameter or a fixed
       N; if parameter + dashboard, it adds the param to `filters.parameters`.
  6. **Dashboard filter actions:** `DashboardSpec.actions` `[{type:'filter',runOn,
     excludeSheets}]` -> workbook-level `<actions>` (before `<worksheets>`) with
     `<command command='tsc:tsl-filter'>`; KPI source sheets auto-excluded;
     modify replaces (no duplicate) via `removeActionsForDashboard`
     (`workbookCompiler.applyDashboards`).
  Agent instructions gained sections for all five. Tests: 9 new evals (worksheet-eval +
  dashboard-eval). Full suite: 77 tests passing, typecheck clean. Verified end-to-end:
  a single build exercising every feature validates and produces well-formed TWBX.
- **Dashboard layout + title formatting** (all modeled on the sample's `<zone-style>`
  and title `<run>` patterns):
  - New shared schemas in `common.ts`: `TextFormatSchema` ({fontSize,color,bold,
    alignment,fontName,backgroundColor}), `BorderSpecSchema` ({color,style,width}),
    `FontAlignmentSchema`.
  - `DashboardSpec` (schemas/dashboard.ts) gained `outerPadding` (root zone margin,
    default 8), `innerPadding` (per-zone margin, default 4), `border` (container
    border), `titleFormat` (title band). `DashboardFiltersSpec` gained
    `panelTitleFormat`. `backgroundColor` (dashboard color, `<style-rule
    element='table'>`) + `containerBackground` (`<zone-style>` background) were
    already present and remain the "dashboard color" / "container color" knobs.
  - `dashboardCompiler.ts`: `leafStyle`/`containerStyle` now take `(margin, border)`;
    new `borderLines()` and `runOpen(fmt, defaults)` helpers. Root zone-style margin =
    outerPadding; every zone margin = innerPadding; title band + filter heading use
    `runOpen` (alignment left=0/center=1/right=2). Title zone gets a background when
    `titleFormat.backgroundColor` is set.
  - **Sheet title formatting** is a WORKSHEET property: `FormattingSpec.titleFormat`
    (worksheet.ts) -> `worksheetCompiler.injectTitleLayout()` inserts
    `<layout-options><title><formatted-text><run ...>` right after `<worksheet name>`
    (before `<table>`), only when a titleFormat is present (default sheets unchanged).
    `formatting.title` overrides the title text. Shows on the sheet AND the dashboard.
  - Agent guidance: added "Layout / formatting" + "Sheet TITLE formatting" bullets to
    the Dashboards section. Tests: +3 evals (dashboard layout formatting; worksheet
    title-format present/absent). Full suite: 80 passing, typecheck clean. E2E probe:
    a build with all layout knobs + a formatted sheet title validates (target-scoped)
    and is well-formed.
- **Dashboard size types (automatic / range / fixed) + container sizing:**
  - `DashboardSizeModeSchema` now `["automatic","range","fixed"]`. `DashboardSpec`
    gained range bounds `minWidth/minHeight/maxWidth/maxHeight`; `width/height`
    remain for fixed. `dashboardCompiler.buildSizeXml()` emits
    `<size sizing-mode='automatic'/>`, fixed (`min==max==width/height`, default
    1200x1200), or range (`sizing-mode='range'`, defaults min 800x600/max 1200x900,
    max clamped >= min). Matches the sample's `<size ... sizing-mode='fixed'/>`.
  - Container sizing: `DashboardSheet.width` + `DashboardRow.height` (px) override
    `widthWeight`/`heightWeight` and feed `partitionH`/`partitionV` (normalized by
    sum, so px are exact when they add up to the board dimension; act as weights on
    automatic boards).
  - Agent guidance: "Dashboard SIZE type (ALWAYS ask first)" - agent asks the user
    for Automatic/Range/Fixed on a new dashboard and applies size; modifyDashboard
    (same name) changes size type/dimensions or container sizes in place. Tests:
    +3 evals (range; range defaults+clamp; container px sizing). Full suite: 83
    passing, typecheck clean. E2E probe: a RANGE board with sized containers builds,
    validates (target-scoped), and is well-formed.
- **Derived-field (bin/group/calc) source-column dependency fix** - resolves the
  Tableau load error "Field '[ds].[none:<field>:nk]' which is included for filtering
  does not exist" when a dashboard apply-to-all filter (or any pill) targets a
  DERIVED field such as a categorical-bin ("Patient Age (group)" = bins of
  `patient_age`), a group, or a calculated field.
  - Root cause: a worksheet's `<datasource-dependencies>` must also declare the
    SOURCE column(s) a derived field is built from; we only declared the derived
    column + its instance, so Tableau couldn't resolve it. (Plain physical columns
    like Region have no source, which is why they always worked. Also: `parseFields`
    only detected `<calculation formula=...>`, missing bins whose calc uses
    `column='[patient_age]'` and `<bin>` children.)
  - Fix: `FieldInfo.dependsOn: string[]` (workbook.ts). `twb.ts` populates it from
    any nested `<calculation ... column='[X]'>` (bins/groups); `calculatedFields.ts`
    populates it from `[bracket]` refs in a new calc's formula. New
    `plainColumnDecl()` (columnInstance.ts) emits a source `<column .../>`.
    `DependencyBuilder` (worksheetCompiler) now takes the `FieldIndex` and, in
    `add()`, recursively co-declares each used field's source columns. Dashboard
    apply-to-all: `ResolvedFilterField.sourceColumnDecls` (dashboardCompiler
    `resolveFilterField`) + `dashboardFilters.ensureDecls` inject the source columns
    into every worksheet that gets the filter.
  - Verified on the user's real workbook (TestWB3, HOSPITAL_ER_DS): the bin filter
    now co-declares `[patient_age]` in all sheets; build validates + well-formed.
    Tests: +2 evals (worksheet source-column co-declaration; dashboard apply-to-all
    derived source). Full suite: 85 passing, typecheck + lint clean.
