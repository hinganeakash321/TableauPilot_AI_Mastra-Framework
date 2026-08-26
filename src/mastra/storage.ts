/**
 * Shared libSQL storage used by Mastra (workflow snapshots, telemetry) and by
 * Memory. A single store keeps suspend/resume state durable across restarts.
 */

import { LibSQLStore } from "@mastra/libsql";

const url = process.env.DATABASE_URL ?? "file:./mastra.db";

export const storage = new LibSQLStore({ id: "tableaupilot", url });
