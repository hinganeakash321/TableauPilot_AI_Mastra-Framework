# Python Dependency Decision

**Decision: Python is NOT used in TableauPilot AI.**

Per the architecture principle (spec sections 1, 21, 22), Python may only be
introduced when a specific Tableau capability cannot be implemented reliably with
TypeScript/Node.js and the available Tableau APIs. During implementation, every
required capability was achievable in TypeScript, so **no Python service, adapter,
or dependency exists in this project.**

## Capabilities evaluated and how they were solved in TypeScript

| Capability | Python option (not used) | TypeScript solution actually used |
| --- | --- | --- |
| Open/unzip a `.twbx` | `tableaudocumentapi` | `jszip` (`src/tableau/twbx.ts`) — extracts the `.twb` and preserves every other entry (incl. `.hyper`) byte-for-byte |
| Read workbook metadata (datasources, fields, calcs, params, worksheets) | Document API | `fast-xml-parser` read-only parse (`src/tableau/twb.ts`, `src/tableau/inspect.ts`) |
| Modify the workbook (add worksheets) | Document API | Deterministic, targeted **string insertion** into the TWB XML (`src/tableau/xml.ts`, `src/tableau/compiler/*`). This preserves the locked datasource block and existing formatting exactly — something full re-serialization (Document API) risks changing |
| Re-package a `.twbx` | Document API `.save()` | `jszip` re-zip preserving original entries (`src/tableau/twbx.ts`) |
| Inspect a Hyper extract | `tableauhyperapi` | The `.hyper` is treated as an **opaque, preserved artifact**. We never read/write extract rows — we only reuse the existing extract, so the Hyper API is unnecessary |
| Publish to Tableau Cloud | `tableauserverclient` (TSC) | Tableau **REST API** implemented directly in TypeScript with an injectable `fetch` (`src/tableau/cloud/tableauCloudService.ts`): sign-in (PAT), project listing, multipart publish, verification |

## Why the TypeScript approach is actually *better* here

1. **Datasource preservation is the #1 invariant.** Targeted string edits guarantee
   the datasource block and `.hyper` are untouched. A full document round-trip could
   silently reformat or drop attributes.
2. **The LLM never writes XML.** The agent emits Zod-validated `WorksheetSpec`s and a
   deterministic compiler produces XML from real sample-workbook patterns. This
   contract is language-agnostic and needs no Python runtime.
3. **Single runtime / single toolchain.** One `npm install`, one process, one
   observability surface in Mastra Studio — no cross-language IPC, no `.venv`.

## When we *would* add Python

If a future requirement needs to **read or rewrite rows inside a Hyper extract**, or
perform a Tableau operation with no REST equivalent, we would add an isolated
adapter exactly as the spec prescribes:

```
Mastra Tool -> TableauEngineAdapter (TS) -> Python service (FastAPI) -> Tableau Hyper/Document API
```

It would live under `tableau-engine/`, be reachable only through the adapter, and be
optional for the agent, workflows, memory, tools, Studio, Cloud REST, TWBX zipping,
and XML parsing. Until such a requirement is proven, adding Python would be
unjustified complexity.
