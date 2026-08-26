/**
 * Context-management processor (spec section 57).
 *
 * Ensures the full TWB XML is never sent to the LLM. If a user message contains
 * raw workbook XML or an excessively large blob, it is replaced with a short
 * note directing the agent to use the deterministic inspection tools instead.
 */

import type {
  ProcessInputArgs,
  ProcessInputResult,
} from "@mastra/core/processors";

/** Max characters allowed in a single user text part before trimming. */
const MAX_TEXT_CHARS = 8_000;
const XML_MARKERS = ["<workbook", "<datasource", "<worksheet", "<?xml"];

export const contextManager = {
  id: "context-manager",
  name: "Context Manager",
  description:
    "Prevents raw Tableau XML and oversized blobs from being sent to the model.",
  processInput(args: ProcessInputArgs): ProcessInputResult {
    for (const message of args.messages) {
      if (message.role !== "user") continue;
      const parts = (message.content?.parts ?? []) as Array<{
        type?: string;
        text?: string;
      }>;
      for (const part of parts) {
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const looksLikeXml = XML_MARKERS.some((m) => part.text!.includes(m));
        if (looksLikeXml) {
          part.text =
            "[Removed raw Tableau XML from the prompt. Use the inspection tools " +
            "(inspectWorkbook, inspectFields, etc.) to read workbook metadata " +
            "instead of pasting XML.]";
        } else if (part.text.length > MAX_TEXT_CHARS) {
          part.text =
            part.text.slice(0, MAX_TEXT_CHARS) +
            "\n[...truncated for context management...]";
        }
      }
    }
    return args.messages;
  },
};
