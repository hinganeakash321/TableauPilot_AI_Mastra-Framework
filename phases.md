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

## Phase ordering rationale
Engine (Phases 4-7) is built and unit-tested before wiring tools/agent/workflows
(Phases 8-11) so the deterministic core is solid before adding the agentic layer.
