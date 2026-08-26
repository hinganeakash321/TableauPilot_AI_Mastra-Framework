# TableauPilot AI - Engineering & AI Rules

These rules are binding for all code in this repository.

## 1. Technology - USE

- **TypeScript (strict)** as the primary language. `strict: true`, avoid `any`.
- **Mastra** for Agent, Workflows, Tools, Memory, Processors, Studio, Observability.
- **Zod** for all runtime validation and structured output.
- **Anthropic Claude via Anthropic Gateway** using values from `.env`.
- Node libraries for Tableau work: `jszip` (TWBX zip), `fast-xml-parser` (read XML),
  targeted string insertion for XML writes, `undici` (custom fetch/CA), `fetch`
  (Tableau REST).
- **Vitest** for tests.

## 2. Technology - AVOID

- Do NOT introduce **Python** unless a specific Tableau capability cannot be done
  reliably in TS. If ever required, isolate behind an adapter and document in
  `docs/python-dependency-decision.md`. (Currently: not required.)
- Do NOT hard-code API keys, gateway URLs, model names, tokens, or secrets.
  Everything comes from `.env` via `src/config/env.ts`.
- Do NOT use deprecated Mastra APIs. Use current `createTool`, `createStep`,
  `createWorkflow`, `Agent`, `Mastra`, `Memory`, `LibSQLStore`.
- Do NOT build a custom Studio replacement.
- Do NOT send full TWB XML to the LLM (context management).

## 3. AI Boundaries (hard invariants)

The agent MUST NOT:
1. Treat anything but the uploaded TWBX as the source of truth.
2. Create / replace / reconnect / migrate a datasource, or add a second one.
3. Change connector or switch Live <-> Extract.
4. Invent fields that do not exist in the locked datasource.
5. **Generate Tableau XML directly** (must emit Zod specs only).
6. Create dashboards (worksheets only).
7. Modify the workbook without human approval.
8. Claim success without validation.
9. Expose secrets anywhere (memory, state, prompts, tool outputs, logs, traces, XML).

The agent MUST:
- Produce validated Zod structured output (e.g. `WorksheetPlan`) before any change.
- Enforce the datasource lock before any worksheet modification.
- Refuse out-of-scope requests (dashboards, datasource changes) with a clear message.

## 4. Datasource lock rules

- Exactly one datasource is locked per workbook context.
- Before ANY worksheet modification, validate the lock. On mismatch, STOP and
  return `DATASOURCE_LOCK_VIOLATION`.
- Never mutate the datasource block or any `Data/**` file (incl. `.hyper`).

## 5. Error handling

- Every tool returns a **structured result**: on failure, return a typed error
  object (`{ ok: false, error: { code, message, details? } }` style via Zod),
  never throw raw strings across tool boundaries.
- Error codes are stable identifiers, e.g.:
  - `DATASOURCE_LOCK_VIOLATION`
  - `FIELD_NOT_FOUND`
  - `UNSUPPORTED_CHART_TYPE`
  - `DASHBOARD_OUT_OF_SCOPE`
  - `TWBX_INVALID`
  - `TWB_XML_INVALID`
  - `WORKSHEET_COLLISION`
  - `DEPLOYMENT_AUTH_FAILED`
  - `VALIDATION_FAILED`
- Validation failures must be explicit and actionable (include suggestions where
  possible, e.g. nearest field name matches).
- Never report an invalid TWBX / unverified deployment as success.

## 6. Security rules

- Secrets are read only from `.env` and only where needed (model layer, cloud
  service). PAT secrets are entered at deploy time and never stored in memory,
  workflow state, or logs.
- The `logger.redact()` utility must wrap anything potentially sensitive before
  logging or attaching to traces.
- Long-term memory stores only non-sensitive preferences (chart type, number
  format, currency, naming style). Never credentials.

## 7. Human-in-the-loop & tool approval

- Workbook modification requires workflow `suspend()` + explicit approval before
  continuing (real HITL, not a boolean flag in a prompt).
- High-impact tools use `requireApproval: true`: package TWBX, modify existing
  worksheet, Tableau Cloud publish/overwrite.

## 8. Code conventions

- One responsibility per module; keep heavy Tableau logic in `src/tableau/`, not
  inside tools. Tools orchestrate; the engine implements.
- All tool/step I/O uses Zod schemas from `src/mastra/schemas/`.
- Prefer pure, deterministic functions in the engine for testability.
- No comments that merely narrate code; comment only non-obvious intent.
