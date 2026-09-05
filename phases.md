# TableauPilot AI - Implementation Phases

Each phase maps to the plan's to-dos. A phase is "done" when its files exist,
typecheck, and (where applicable) have passing tests.

## Phase 0 - Project setup  [DONE]
- `package.json`, `tsconfig.json` (strict), `.gitignore`, `.env.example`.
- Directory structure (`src/**`, `templates/**`, `workspace/**`, `artifacts/**`,
  `tests/**`, `docs/`).
- Install pinned Mastra + AI SDK + Tableau libs.

## Phase 1 - Config & model layer
- `src/config/logger.ts` - safe logging + `redact()`.
- `src/config/env.ts` - Zod-validated env loader (names from `.env`).
- `src/mastra/models.ts` - Anthropic gateway provider (key helper + CA + fallback),
  `getModel()`.

## Phase 2 - Zod schemas
- `src/mastra/schemas/{workbook,datasource,worksheet,deployment}.ts` and an
  `index.ts` barrel. All schemas from the spec.

## Phase 3 - Sample workbook analysis & templates
- `sample_workbook_analysis.md` (version, datasource, fields, XML patterns, naming).
- `templates/sample-1/` extracted worksheet XML blocks.
- `templates/registry/` chartType -> template + required shelves mapping.

## Phase 4 - Tableau engine: inspection
- `src/tableau/xml.ts` - read parse + targeted insertion helpers.
- `src/tableau/twbx.ts` - unzip/repackage preserving `Data/**`.
- `src/tableau/twb.ts` - metadata extraction into `WorkbookInspectionResult`.

## Phase 5 - Tableau engine: compiler
- `src/tableau/compiler/columnInstance.ts` - naming rules.
- `src/tableau/compiler/charts/*` - per-chart-type builders from real templates.
- `src/tableau/compiler/worksheetCompiler.ts` + `workbookCompiler.ts` - insert
  worksheet + window blocks.

## Phase 6 - Tableau engine: validators
- `src/tableau/validators/*` - TWB XML, datasource-reference, field-existence,
  worksheet-reference, TWBX structure.

## Phase 7 - Tableau Cloud service
- `src/tableau/cloud/tableauCloudService.ts` - REST sign-in (PAT), list/resolve
  projects, multipart publish, verify; injectable `fetch` for mocks.

## Phase 8 - Mastra tools
- `src/mastra/tools/{workbookTools,datasourceTools,worksheetTools,buildTools,deploymentTools}.ts`
  with Zod I/O, structured errors, `requireApproval` on high-impact ops.

## Phase 9 - Agent, memory, processors
- `src/mastra/memory/memory.ts` - libSQL memory (per-workbook context).
- `src/mastra/processors/{security,context,validation}.ts`.
- `src/mastra/agents/tableauPilotAgent.ts` - invariants + structured output.

## Phase 10 - Workflows
- `src/mastra/workflows/{workbookInspection,worksheetPlanning,worksheetGeneration,workbookBuild,deployment}.ts`
  with `suspend()`/`resume()` HITL.

## Phase 11 - Mastra instance & Studio
- `src/mastra/index.ts` registering agents/workflows/memory/storage/observability.
- Verify `mastra dev` launches Studio and lists everything.

## Phase 12 - Tests & evals
- Vitest unit + integration tests; eval scenarios (monthly trend, top 10, KPI).
- Mock all external systems.

## Phase 13 - Docs
- `README.md` (all spec sections incl. Studio workflow + 8 test scenarios).
- `docs/python-dependency-decision.md`.

## Phase 14 - Dashboards (build + modify)
- `src/mastra/schemas/dashboard.ts` - `DashboardSpec` (name, title, sizeMode
  automatic/fixed, background/container colors, chart-grid `rows`, Filters panel).
- `src/tableau/compiler/dashboardCompiler.ts` - deterministic dashboard XML
  (style/size/datasource-dependencies, zone tree: title band + chart grid + right
  Filters panel, window + viewpoints), modeled on the two sample dashboards.
- `src/tableau/compiler/dashboardFilters.ts` - "apply to all worksheets" via a
  shared `filter-group` context filter (default select-all) injected into every
  worksheet using the locked datasource.
- Wiring: `workbookCompiler.applyDashboards` (+ replace-by-name for modify) and
  `build.ts` (`dashboards?` threaded through compile/build, applied after sheets).
- Tools: `src/mastra/tools/dashboardTools.ts` (`createDashboard`, `modifyDashboard`).
- Validation: `validateDashboardReferences` (zones + viewpoints -> real sheets).
- Docs/templates: `sample_dashboard_analysis.md`, `templates/sample-1/dash_*.xml`.
- Tests: `tests/evals/dashboard-eval.test.ts` (compile + injection + end-to-end).

## Phase 15 - Advanced viz features (colors, ref lines, totals, discrete/continuous, parameters, actions)
- Schemas: `FieldSpec.continuous` + `FieldSpec.colors`, `WorksheetSpec.referenceLines`
  + `grandTotals`, `TopN.nParameter`, extended `ParameterSpec` (domain/range),
  `DashboardSpec.actions`, `HexColorSchema` (`common.ts`).
- `src/tableau/compiler/parameters.ts` - creates/reuses parameters in the
  `<datasource name='Parameters'>` pseudo-datasource; re-emits a param column for a
  worksheet's `<datasource-dependencies>`.
- `worksheetCompiler.ts` - `buildColorEncodings` (per-member hex palette),
  `buildReferenceLines`, grand-total shelf attrs, discrete/continuous via
  `resolvePill`, and parameter-driven Top-N (`count='[Parameters].[Parameter N]'`).
- `workbookCompiler.ts` - creates parameters in `applyWorksheets`; builds
  workbook-level filter `<actions>` in `applyDashboards` (KPI sources auto-excluded,
  replace-on-modify).
- Wiring: `build.ts` + `compileWorkbook` tool gain `parameters`; agent instructions
  gained sections for all five. Validator skips the Parameters pseudo-datasource.
- Tests: 9 new evals; whole feature set verified end-to-end into a valid TWBX.

## Phase 16 - Dashboard layout & title formatting
- `DashboardSpec`: `outerPadding`, `innerPadding`, `border`, `titleFormat`;
  `DashboardFiltersSpec.panelTitleFormat`; `backgroundColor`/`containerBackground`
  remain the dashboard/container colors. Shared `TextFormatSchema`/`BorderSpecSchema`
  in `common.ts`.
- `dashboardCompiler.ts`: padding via zone `margin` (root=outer, zones=inner),
  container `border`, title/filter-heading fonts via `runOpen`.
- Sheet titles: `FormattingSpec.titleFormat` -> `worksheetCompiler.injectTitleLayout`
  emits `<layout-options><title>` (opt-in; shows on sheet + dashboard).
- Tests: +3 evals; 80 total. Verified via an all-knobs e2e build.

## Phase 17 - Dashboard size types & container sizing
- `sizeMode` now automatic | range | fixed; `DashboardSpec` gains range bounds
  (`minWidth/minHeight/maxWidth/maxHeight`); `dashboardCompiler.buildSizeXml`
  emits the matching `<size>` (range clamps max >= min).
- Container sizing: `DashboardSheet.width` + `DashboardRow.height` (px) drive the
  layout partition (px on fixed/range; weights on automatic).
- Agent asks the user for the size type on a new dashboard and applies it;
  modifyDashboard changes size type/dimensions/container sizes in place.
- Tests: +3 evals; 83 total. Verified via a range-board e2e build.

## Phase ordering rationale
Engine (Phases 4-7) is built and unit-tested before wiring tools/agent/workflows
(Phases 8-11) so the deterministic core is solid before adding the agentic layer.
Dashboards (Phase 14) reuse that same deterministic-compiler + validate + build
pipeline, so they were added on top without changing the worksheet core.
