/**
 * Mastra Memory for the TableauPilot agent (spec sections 54, 55).
 *
 * Working memory captures the per-workbook context (current workbook, locked
 * datasource, phase, last approved plan). Threads are keyed per workbook so
 * datasource context never leaks between unrelated workbooks. Only non-sensitive
 * preferences are ever stored (no credentials).
 */

import { Memory } from "@mastra/memory";
import { storage } from "../storage.js";

const WORKING_MEMORY_TEMPLATE = `# TableauPilot Session
- **Current workbook**: (path)
- **Locked datasource**: (name / id) 🔒
- **Connection mode**: (live/extract)
- **Current phase**: (inspect | build | deploy)
- **Last approved plan**: (summary of worksheets)

## Preferences (non-sensitive only)
- **Preferred chart types**:
- **Preferred number format**:
- **Preferred currency**:
- **Naming style**:

<!-- NEVER store API keys, PAT secrets, passwords, or tokens here. -->
`;

export const memory = new Memory({
  storage,
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      template: WORKING_MEMORY_TEMPLATE,
    },
  },
});
