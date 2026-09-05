# TableauPilot AI

**Your Agentic AI Copilot for Tableau** — built with [Mastra AI](https://mastra.ai), TypeScript, and Anthropic Claude.

TableauPilot AI takes an existing Tableau packaged workbook (`.twbx`) as the single
source of truth, **locks and reuses its existing datasource**, understands
natural-language worksheet requirements, and generates **real, validated Tableau
worksheets** inside the workbook — then packages a downloadable `.twbx` and can
optionally publish a user-provided `.twbx` to Tableau Cloud.

Crucially: **the LLM never writes Tableau XML.** The agent produces Zod-validated
structured specs; a deterministic TypeScript compiler turns those into Tableau XML
using patterns extracted from a real reference workbook.

---

## Table of contents

- [Why TableauPilot AI](#why-tableaupilot-ai)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [How the AI is built with Mastra](#how-the-ai-is-built-with-mastra)
- [The datasource lock (the #1 rule)](#the-datasource-lock-the-1-rule)
- [Project structure](#project-structure)
- [Installation](#installation)
- [Environment configuration (`.env`)](#environment-configuration-env)
- [Running Mastra Studio](#running-mastra-studio)
- [Studio test scenarios](#studio-test-scenarios)
- [Testing & evaluation](#testing--evaluation)
- [Observability](#observability)
- [Tableau Cloud deployment](#tableau-cloud-deployment)
- [Security](#security)
- [Limitations](#limitations)
- [Future improvements](#future-improvements)

---

## Why TableauPilot AI

Analysts constantly rebuild the same worksheets by hand. TableauPilot AI lets you
describe what you want ("monthly sales trend", "top 10 customers by sales", "total
sales KPI") and returns a validated `.twbx` with those sheets added — **without
touching your data connection**. It is a portfolio-grade demonstration of a safe,
agentic system: structured outputs, human approval gates, tool approval, memory,
processors, and full observability.

## Architecture

```
                         TABLEAUPILOT AI
   USER
    │
    ▼
  MASTRA STUDIO
    │
    ▼
  TABLEAUPILOT AGENT
    │
 ┌──────────────┼─────────────────┐
 ▼              ▼                  ▼
TOOLS        WORKFLOWS           MEMORY
 │              │                  │
 └──────────────┼──────────────────┘
                │
           PROCESSORS   (security · context · validation)
                │
                ▼
        ZOD STRUCTURED OUTPUT   (WorksheetPlan / WorksheetSpec)
                │
                ▼
     TYPESCRIPT TABLEAU ENGINE
                │
 ┌──────────────┼──────────────┐
 ▼              ▼               ▼
TWB           TWBX          REST API
 │              │               │
 └──────────────┼───────────────┘
                ▼
            VALIDATION
                │
                ▼
          DOWNLOAD TWBX
                │
                ▼
          TABLEAU CLOUD  →  PUBLISH
```

**The critical rule — the LLM never generates XML:**

```
User → Mastra Agent → Zod WorksheetSpec → Validation
     → Deterministic TypeScript compiler → Tableau XML → TWB → TWBX
```

The model + auth path is fully environment-driven:

```
.env → Env config → Mastra model layer → Anthropic-compatible gateway → Claude → Agent
```

See [`architecture.md`](architecture.md) and [`design.md`](design.md) for details.

## Technology stack

- **Language:** TypeScript (strict), Node.js ≥ 20.9
- **Agent framework:** Mastra — Agent, Workflows, Tools, Memory, Processors, Studio, Observability
- **LLM:** Anthropic Claude via an Anthropic-compatible **gateway** (dynamic key helper + corporate CA supported); OpenRouter fallback
- **Validation / structured output:** Zod
- **Tableau engine (all TypeScript):** `fast-xml-parser` (read-only inspect), targeted XML string editing (safe writes), `jszip` (TWBX open/repackage), Tableau **REST API** client for Cloud
- **Storage:** LibSQL (`@mastra/libsql`) for memory, workflow snapshots, and traces
- **Testing:** Vitest (unit + integration + eval), external systems mocked
- **Python:** **none** — see [`docs/python-dependency-decision.md`](docs/python-dependency-decision.md)

## How the AI is built with Mastra

**Agent** — `tableauPilotAgent` (`src/mastra/agents/tableauPilotAgent.ts`): understands
requirements, inspects metadata via tools, plans worksheets as structured output,
enforces the datasource lock, and coordinates builds with human approval. It builds
both worksheets and dashboards (a dashboard only arranges existing worksheets). Its
instructions encode hard invariants (no new datasource, no raw XML, no modification
without approval, never claim success without validation).

**Tools** (`src/mastra/tools/*`) — each with Zod input/output schemas, structured
errors, and safe logging:

- *Workbook:* `inspectWorkbook`, `inspectDatasources`, `inspectConnections`, `inspectFields`, `inspectWorksheets`, `inspectCalculatedFields`, `inspectParameters`, `inspectExtracts`
- *Datasource:* `validateDatasource`, `lockDatasource`, `validateDatasourceLock`, `applyDatasourceFilter`, `validateExtract`
- *Worksheet:* `validateField`, `createWorksheet`, `modifyWorksheet` *(approval)*, `createCalculatedField`, `createParameter`, `addWorksheetFilter`, `validateWorksheet`
- *Build:* `compileWorksheet`, `compileWorkbook`, `validateTwb`, `packageTwbx` *(approval)*, `validateTwbx`
- *Dashboard:* `createDashboard`, `modifyDashboard` (sample-faithful layout + apply-to-all filters + use-as-filter actions)
- *Data (read-only extract):* `inspectData`, `profileField`, `queryData`
- *Deployment:* `connectTableauCloud`, `listProjects`, `resolveProject`, `validatePublish`, `publishWorkbook` *(approval)*, `verifyWorkbook`

**Workflows** (`src/mastra/workflows/*`) — deterministic multi-step sequences with
real suspend/resume human-in-the-loop:

- `workbookInspectionWorkflow` — preserve original → inspect → lock datasource
- `worksheetPlanningWorkflow` — requirements → structured `WorksheetPlan`
- `worksheetGenerationWorkflow` — validate plan → **suspend for approval** → compile → validate → package
- `twbxBuildWorkflow` — compile → validate (XML / datasource / worksheet) → package → final validation
- `tableauCloudDeploymentWorkflow` — **suspend for credentials** → resolve project → preview → **suspend for approval** → publish → verify

**Memory** (`src/mastra/memory/memory.ts`) — LibSQL-backed working memory scoped per
workbook; a new `.twbx` starts a fresh context and datasource context never leaks
across workbooks. Only non-sensitive preferences are ever retained.

**Processors** (`src/mastra/processors/*`) — each with a real purpose:
Unicode normalization, secret redaction, prompt-injection guard, and a context
manager that strips raw Tableau XML / oversized blobs so the model only ever sees
metadata (never the full TWB XML).

**Structured output** — the agent emits a Zod-validated `WorksheetPlan`; nothing
modifies a workbook until the plan validates and the human approves.

## The datasource lock (the #1 rule)

```
USER TWBX → EXISTING DATASOURCE → 🔒 DATASOURCE LOCK
         → ALL WORKSHEETS USE THE SAME DATASOURCE
         → SAME TWBX → VALIDATED TWBX → DOWNLOAD → (optional) DEPLOY
```

The agent will **never** create, replace, reconnect, migrate, or duplicate a
datasource, and never switches Live/Extract. If a single datasource exists it is
auto-locked; if several exist you are asked to choose. Every worksheet operation is
guarded — a mismatch returns `DATASOURCE_LOCK_VIOLATION`. Originals are never
modified in place (`workspace/original|working|output`).

## Project structure

```
src/
  config/            env + safe logger
  mastra/
    index.ts         Mastra instance (agent, workflows, storage, memory, observability)
    agents/          tableauPilotAgent
    tools/           workbook / datasource / worksheet / build / deployment tools
    workflows/       inspection / planning / generation / build / deployment
    processors/      security / context / validation
    memory/          libsql-backed working memory
    server/          upload routes + drag-and-drop /upload page
    schemas/         all Zod schemas (single source of types)
  tableau/           TypeScript Tableau engine
    twbx.ts twb.ts xml.ts inspect.ts lock.ts build.ts paths.ts
    compiler/        columnInstance · worksheetCompiler · workbookCompiler
    validators/      TWB/TWBX validators
    cloud/           Tableau Cloud REST client
templates/           sample-1 (real XML references) + chart registry
tests/               unit · integration · evals
docs/                python-dependency-decision.md
uploads/             inbox for uploaded .twbx files
workspace/           original · working · output artifacts
```

Planning/design docs: [`prd.md`](prd.md), [`architecture.md`](architecture.md),
[`rules.md`](rules.md), [`phases.md`](phases.md), [`design.md`](design.md),
[`memory.md`](memory.md), [`sample_workbook_analysis.md`](sample_workbook_analysis.md).

## Installation

```bash
npm install
cp .env.example .env   # then fill in real values (see below)
npm run typecheck      # optional: verify the TypeScript build
```

Requirements: Node.js ≥ 20.9. Provide a workbook by uploading it at
http://localhost:4111/upload (recommended) or dropping it into `uploads/`; the
bundled `./sample_workbook.twbx` also works out of the box.

## Environment configuration (`.env`)

`.env` is the **single source of truth**; secrets are never hard-coded, logged, or
sent to the model. Configuration is validated at runtime by Zod (`src/config/env.ts`)
and consumed by the model layer (`src/mastra/models.ts`).

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | `anthropic` (via gateway) or `openrouter` |
| `LLM_MODEL` | Model id (e.g. `claude-sonnet-4-6`) |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible gateway root (no trailing `/v1`) |
| `ANTHROPIC_API_KEY` **or** `ANTHROPIC_API_KEY_HELPER` | Static key, or a command that prints a token at runtime |
| `ANTHROPIC_CA_CERT` | Optional corporate/self-signed CA bundle for the gateway |
| `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` | Fallback provider |
| `TABLEAU_VERSION` | Target Tableau version (e.g. `2026.1`) |
| `WORKSPACE_PATH` | Root for `original/working/output` artifacts |
| `LOG_LEVEL` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `HYPERD_PATH` | Optional override for the `hyperd` engine used to read extract data (auto-detected otherwise) |
| `TABLEAU_CLOUD_URL` / `TABLEAU_SITE_CONTENT_URL` / `TABLEAU_PAT_NAME` / `TABLEAU_PAT_SECRET` | Optional local-only deploy defaults; normally entered at deploy time and never stored |

The Anthropic gateway path supports a **dynamic key helper** (the token is captured
per request, refreshed on 401, and never logged) and a **corporate CA** injected via
`undici`.

## Reading the underlying data (extract `.hyper`)

The agent can read the workbook's **actual data** — not just metadata — to answer
questions like *"how many years of data are present?"*, value ranges, distinct counts,
row counts, and small previews (tools `inspectData`, `profileField`, `queryData`). This
is **read-only**; the workbook is never modified.

A `.twbx` contains the `.hyper` **data**, but querying it needs the Hyper query
**engine** (`hyperd`) — a native binary that is *not* shipped inside the TWBX or the
npm package. It uses Tableau's official Rust-backed Node bindings (`hyperdb-api-node`),
so **no Python** is involved. `hyperd` is located in this order:

1. `HYPERD_PATH` env var, if set;
2. a bundled copy at `./.hyperd/hyper/hyperd` (from `npm run hyperd:setup`);
3. an installed **Tableau Desktop / Prep** app (auto-detected on your dev machine);
4. a `tableauhyperapi` Python install, if present.

> Requires **Node.js ≥ 21** for this feature (the native addon). Everything else —
> building worksheets, calculated fields, filters, packaging, deploy — is pure
> TypeScript and runs on Node ≥ 20.9 without `hyperd`.

### Deploying elsewhere (servers / containers with no Tableau)

On a clean host, download the pinned `hyperd` once into the project:

```bash
npm run hyperd:setup        # downloads ./.hyperd/hyper/hyperd for your platform
# pick a specific release if the default pin is yanked:
# node scripts/download-hyperd.mjs --version 0.0.24457 --build-id rc36858b6
```

Or build the provided image, which bundles `hyperd` automatically:

```bash
docker build -t tableaupilot .
docker run -p 5173:5173 --env-file .env tableaupilot
```

Supported `hyperd` platforms: macOS arm64/x64, Linux x64, Windows x64. If the feature
can't find `hyperd`, the data tools return a clear error while all other capabilities
keep working.

## Running the web UI (Node.js)

A lightweight Node.js (Express) chat UI is the primary end-user surface — no Mastra
Studio required. It runs the agent in-process and adds first-class **upload** and
**download** buttons.

```bash
npm run ui       # starts the web UI (tsx web/server.ts)
```

Then open **http://localhost:5173** (override with `WEB_PORT`). The UI is a 3-step wizard:

1. **Upload & check datasource** — Upload your `.twbx` (drag-and-drop or click). The binary
   is saved to the `uploads/` inbox — never pasted into chat, never sent to the LLM. The
   workbook is inspected locally (deterministically, no LLM) and its datasource is locked;
   the panel shows field/dimension/measure/worksheet counts. If there are multiple
   datasources you pick which one to lock.
2. **Build visualization** — Chat to describe the charts you want (e.g. *"Create a monthly
   sales trend, then top 10 customers by sales"*). The agent plans, and — after you confirm —
   compiles, validates, and packages the workbook. Approval-gated steps auto-resume so the
   build completes in one turn. **Download** the rebuilt `.twbx` from the header button.
3. **Deploy** — Publish the built workbook to Tableau Cloud. Enter the server URL, site,
   Personal Access Token, and project. The PAT is used only to sign in for that request —
   never stored, logged, or returned. On success you get the published workbook URL.

Conversation memory is keyed to a per-browser session id, so the locked datasource and
workbook context persist across turns. The model is configured via `LLM_MODEL` in `.env`
(default **`claude-opus-4-8`** through the Anthropic gateway).

Web UI endpoints (served by `web/server.ts`):

| Route | Purpose |
| --- | --- |
| `GET /` | 3-step wizard UI (upload/datasource · build · deploy) |
| `POST /api/upload` | Multipart upload (`file` field) → saves to `uploads/` |
| `GET /api/inspect?name=<file>` | Deterministic inspection + datasource lock (Page 1) |
| `POST /api/chat` | `{ message, sessionId }` → runs the agent, returns text + built file |
| `GET /api/workbooks` | JSON list of available `.twbx`/`.twb` files |
| `GET /api/output` | Most recently built workbook (for the Download button) |
| `GET /api/download?name=<file>` | Streams a workbook as an attachment |
| `POST /api/deploy` | Publishes a built workbook to Tableau Cloud (Page 3) |

## Running Mastra Studio

Mastra Studio remains available as an alternative development and testing surface.

```bash
npm run dev      # (alias: npm run studio) starts Mastra dev + Studio
```

Then open **http://localhost:4111**. Studio exposes the `tableauPilotAgent`, all five
workflows, tools, memory, and traces. Typical loop:

```
Start project → Start Mastra (npm run dev) → Open Studio
→ Select TableauPilot Agent → Test a requirement
→ Inspect tool calls → Inspect workflow execution → Inspect traces → Iterate
```

Build and deploy Studio using the standard Mastra commands:

```bash
npm run build    # mastra build
npm run deploy   # mastra deploy (when a deployment target is configured)
```

## Uploading a workbook (`.twbx`) — never paste it

A `.twbx` is a **binary** file, so it must not be pasted/attached into the Studio
chat (that corrupts it into inlined text). Instead, upload it once and then just
reference it by filename:

- **Drag-and-drop page:** open **http://localhost:4111/upload** and drop your `.twbx`.
- **Command line:** `curl -F "file=@/path/to/Sales.twbx" http://localhost:4111/upload`
- **Manual:** drop the file into the project's `uploads/` folder.

Uploaded files land in `uploads/` (override with `UPLOADS_PATH`). Then in Studio simply
tell the agent, e.g. *"Inspect Sales.twbx"* — the agent uses the `listWorkbooks` tool
to find uploaded files and every tool resolves a bare filename from the uploads inbox
and workspace. The binary is read only by the deterministic TypeScript engine and is
**never** sent to the LLM.

Intake endpoints (served by the Mastra dev server):

| Route | Purpose |
| --- | --- |
| `GET /upload` | Drag-and-drop upload page |
| `POST /upload` | Multipart upload (`file` field) → saves to `uploads/` |
| `GET /workbooks` | JSON list of available `.twbx`/`.twb` files |

## Studio test scenarios

Run these directly against the agent in Studio:

1. **Upload & inspect a workbook** — upload a `.twbx` at http://localhost:4111/upload,
   then ask the agent to *"Inspect &lt;filename&gt;"*; confirm the datasource, fields,
   and existing worksheet count, and that the datasource is 🔒 locked.
2. **"Create a monthly sales trend."** → line chart, `MONTH(Order Date)` on columns, `SUM(Sales)` on rows.
3. **"Create top 10 customers by sales."** → bar chart with a Top-10 filter on Customer by `SUM(Sales)`.
4. **Request a non-existent field** (e.g. `Revenue`) → validation error with close-match suggestions.
5. **"Build a dashboard from these sheets with a Region/Segment filter."** → sample-faithful dashboard (title band, chart grid, right Filters panel with multi-select + Apply, applied to all worksheets).
6. **Attempt datasource replacement/reconnect** → refused with `DATASOURCE_LOCK_VIOLATION`.
7. **Generate a workbook** → approve the plan → receive a validated `.twbx` artifact.
8. **Deploy a workbook** → the deployment workflow suspends for **credentials** and again for **approval** before any publish.

## Testing & evaluation

```bash
npm test          # full Vitest suite (unit + integration + evals)
npm run test:watch
npm run eval      # eval scenarios only (tests/evals)
```

Coverage highlights (external systems fully mocked — no live Tableau Cloud, DBs, or
credentials required):

- **Unit:** Zod schemas, datasource lock resolution, XML helpers, processors (prompt-injection guard + context manager).
- **Integration:** real-`.twbx` inspection; full build pipeline (compile → validate → package → re-inspect) confirming the datasource id survives and worksheets are added; Tableau Cloud REST client against a mock server; both HITL workflows (generation + deployment) exercising suspend/resume for approval.
- **Evals** (`tests/evals`): golden-output checks for the canonical requests — *monthly sales trend*, *top 10 customers*, *total sales KPI* — asserting the compiled XML has the correct marks, pills, and filters. This validates the "requirement → spec → XML" contract without a live LLM; live NL→spec evals are run interactively in Studio.

## Observability

Mastra observability is enabled in `src/mastra/index.ts` with a `MastraStorageExporter`
so agent runs, workflow steps, tool calls, model calls, latency, and errors are
persisted to LibSQL and inspectable in Studio. A `SensitiveDataFilter` is applied so
secrets never reach traces.

## Tableau Cloud deployment

Phase 3 is a full **TypeScript REST** implementation
(`src/tableau/cloud/tableauCloudService.ts`) driven by `tableauCloudDeploymentWorkflow`:

```
Upload TWBX → suspend for credentials (PAT) → sign in → list/resolve real project
→ deployment preview (with overwrite warning) → suspend for approval → publish → verify → return URL
```

- Credentials (server URL, site content URL, PAT name/secret) are provided at the
  **resume** step, used transiently for sign-in, and **never** stored in workflow
  state, memory, logs, or traces — only an opaque session handle flows forward.
- Existing workbooks are detected so overwrite requires explicit approval.
- The deployment result returns `workbookId`, `workbookName`, `projectName`,
  `projectId`, `site`, `webpageUrl`, `publishMode`, and any warnings/errors.

The whole path is tested against a mock REST server; no live publish is performed.

## Security

Secrets (API keys, gateway tokens, PAT secrets) are never placed in agent memory,
workflow state, prompts, tool outputs, logs, traces, Studio-visible data, or
generated XML. The logger redacts sensitive keys, the observability layer filters
sensitive data, and deployment tokens live only in server memory behind a handle.

## Limitations

- **Worksheets & dashboards** — dashboards arrange existing worksheets (title band, chart grid, right Filters panel, apply-to-all multi-select filters, use-as-filter actions), modeled on the sample dashboards.
- **Dashboard sizing** — automatic, range (min/max bounds), or fixed (exact width×height); the agent asks which type you want on a new dashboard and can change it later. Individual container widths/heights are adjustable on request.
- **Dashboard layout & formatting** — dashboard color, per-container background, outer/inner padding, container borders, and title-band / filter-heading font formatting; plus per-worksheet title formatting that shows on the dashboard.
- **Advanced viz features** — per-member chart colors (hex palettes) + measure gradients, reference/average lines, row/column grand totals, discrete↔continuous field conversion, and parameters (create + reuse) usable in parameter-driven Top-N filters and calculated fields.
- **Datasource is read-only** — no creation/replacement/reconnection, no Live↔Extract switch.
- Chart types are limited to those the deterministic compiler supports (see `templates/registry`).
- Hyper extracts are preserved as opaque artifacts; extract *contents* are not read or rewritten.
- Tableau Desktop validation is treated as an optional layer and reports "NOT AVAILABLE" when Desktop isn't present.

## Future improvements

- Broaden the chart registry and formatting coverage from additional reference workbooks.
- Optional lightweight end-user UI over the three phases (Studio remains the dev surface).
- Isolated Python adapter **only if** a future requirement needs Hyper row-level access (documented path in [`docs/python-dependency-decision.md`](docs/python-dependency-decision.md)).
- Richer evals using `@mastra/evals` scorers for live NL→spec quality.

---

Built as a demonstration of safe, production-minded agentic engineering with Mastra AI.
