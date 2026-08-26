# TableauPilot AI - Product Requirements Document (PRD)

> Tagline: "Your Agentic AI Copilot for Tableau"

## 1. Summary

TableauPilot AI is an agentic AI system built on **Mastra (TypeScript)** that turns
natural-language Tableau requirements into **real, validated Tableau worksheets**
inside an **existing TWBX workbook**. The uploaded TWBX is the single source of
truth; its existing datasource is **locked** and reused for every generated
worksheet. The system packages a valid downloadable TWBX and can optionally
deploy a user-provided TWBX to **Tableau Cloud** via REST.

The primary interface for development, testing, and observability is **Mastra
Studio** (`mastra dev`). No separate end-user web app is built in this phase.

## 2. Goals

- Demonstrate a modern agentic system: Agents, Workflows, Tools, Memory,
  Processors, Structured Outputs (Zod), Human-in-the-loop, Tool Approval,
  Observability/Tracing, and Evaluation - all in Mastra.
- Use **Anthropic Claude** through the **Anthropic Gateway** configured in `.env`.
- Keep the stack **TypeScript-first**. Python is introduced only if a concrete
  Tableau capability cannot be reliably done in TS (currently: none).
- The LLM **never** generates Tableau XML directly. It emits validated Zod specs;
  a deterministic TypeScript compiler produces XML from real workbook templates.

## 3. Non-Goals

- No dashboard creation (worksheets/sheets only).
- No datasource creation/replacement/reconnection or Live<->Extract switching.
- No free-form XML from the model.
- No custom Studio replacement UI.
- No live Tableau Cloud publishing in automated tests (mocked).

## 4. Personas

- **BI Developer / Analyst**: uploads a TWBX, describes worksheets in natural
  language, reviews the plan, approves, downloads a validated TWBX, optionally
  deploys to Tableau Cloud.
- **Engineer / Reviewer**: uses Mastra Studio to inspect agent behavior, tool
  calls, workflow steps, traces, memory, and evaluations.

## 5. Core User Flows

### Phase 1 - Upload & Inspect
1. User uploads a TWBX.
2. System inspects workbook + datasource metadata.
3. If one datasource: auto-lock. If multiple: user selects one to lock.
4. Datasource is locked (single source of truth).

### Phase 2 - Build Worksheets
1. User describes worksheets in natural language.
2. Agent produces a **WorksheetPlan** (structured, Zod-validated).
3. Fields validated against the locked datasource (no invented fields).
4. **Human approval** (workflow suspends) before any workbook modification.
5. Deterministic compiler builds worksheet XML; TWB patched; TWBX packaged.
6. TWBX validated; user downloads it.

### Phase 3 - Deploy (optional)
1. User uploads the TWBX they want to deploy (not auto from Phase 2).
2. User provides Tableau Cloud URL, site, PAT name, PAT secret (never logged/stored).
3. System authenticates, lists real projects, user selects one.
4. **Deployment preview + approval** (overwrite protection).
5. Publish, verify, return workbook URL.

## 6. Functional Requirements

| # | Requirement |
|---|-------------|
| FR-1 | Inspect TWBX: workbook name, Tableau version, datasources, connections, Live/Extract, tables, fields (dimensions/measures), calculated fields, parameters, worksheets, filters, extracts. |
| FR-2 | Lock exactly one datasource; enforce a DatasourceLock guard before any modification. |
| FR-3 | Convert NL requirements into a validated `WorksheetPlan` (Zod). |
| FR-4 | Validate every field against the locked datasource; report + suggest matches when missing. |
| FR-5 | Human approval required before modifying the workbook (workflow suspend/resume). |
| FR-6 | Tool approval required for high-impact ops (package TWBX, modify worksheet, publish). |
| FR-7 | Deterministic compiler generates worksheet XML from real templates; inserts `<worksheet>` + `<window class='worksheet'>`. |
| FR-8 | Preserve original workbook + locked datasource + `.hyper` byte-for-byte. |
| FR-9 | Package a valid TWBX (not a renamed TWB) and validate its structure. |
| FR-10 | Support chart types with real templates (bar/line/area/scatter/pie/donut/text table/highlight table/treemap/maps/KPI/histogram/dual-axis/Top N). |
| FR-11 | Refuse dashboard requests with a clear scope message. |
| FR-12 | Tableau Cloud deploy via REST with preview, approval, overwrite protection, verification. |
| FR-13 | Memory: remember current workbook, locked datasource, phase, last approved plan; no cross-workbook leakage. |
| FR-14 | Observability: traces for model/agent/workflow/tool/memory; secrets filtered. |
| FR-15 | Evaluations for representative scenarios. |

## 7. Non-Functional Requirements

- **Security**: never expose API keys, gateway secrets, PAT secrets, passwords,
  or tokens in memory, state, prompts, tool outputs, logs, traces, or XML.
- **TypeScript strict** mode; strong typing; avoid `any`.
- **Determinism**: XML generation is deterministic and template-driven.
- **Testability**: all external systems mockable; no production creds in tests.

## 8. Success Criteria (condensed from spec section 88)

Start app -> open Studio -> see agent + workflows -> upload TWBX -> inspect ->
lock datasource -> request worksheets -> structured plan -> approve -> generate ->
preserve datasource/workbook -> validate TWB -> package TWBX -> validate TWBX ->
download -> (optional) authenticate Tableau Cloud -> select project -> preview ->
approve -> publish -> verify -> return URL.

Fails if: datasource recreated/replaced, dashboard created, LLM emits raw XML,
Studio unavailable, approval skipped, invalid TWBX reported as success,
deployment reported without verification, or secrets exposed.

## 9. Environment (source of truth: `.env`)

- `LLM_PROVIDER`, `LLM_MODEL`
- `ANTHROPIC_BASE_URL`, and one of `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_HELPER`
- `ANTHROPIC_CA_CERT` (optional corporate CA bundle)
- `OPENROUTER_API_KEY` (fallback provider)
- `TABLEAU_VERSION`, `WORKSPACE_PATH`, `LOG_LEVEL`

Variable **names** are documented in `.env.example`; real values live only in `.env`.
