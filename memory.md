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
