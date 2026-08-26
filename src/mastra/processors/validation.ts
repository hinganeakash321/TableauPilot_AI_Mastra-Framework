/**
 * Input validation / prompt-injection protection processor (spec section 56).
 *
 * Blocks classic prompt-injection attempts before they reach the model. This is
 * a deterministic, no-LLM guard; the agent's own instructions enforce the higher
 * level AI boundaries (datasource lock, dashboard scope, no raw XML).
 */

import type {
  ProcessInputArgs,
  ProcessInputResult,
} from "@mastra/core/processors";

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(the\s+)?(system|previous)\s+(prompt|instructions)/i,
  /reveal\s+(your\s+)?(system\s+)?prompt/i,
  /print\s+(your\s+)?(api[_-]?key|secret|token|credentials)/i,
  /you\s+are\s+now\s+(a\s+)?different\s+(ai|assistant|model)/i,
];

/** Extracts concatenated text from a message's parts. */
function messageText(message: {
  content?: { parts?: Array<{ type?: string; text?: string }> };
}): string {
  const parts = message.content?.parts ?? [];
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

export const promptInjectionGuard = {
  id: "prompt-injection-guard",
  name: "Prompt Injection Guard",
  description:
    "Blocks prompt-injection attempts and requests to exfiltrate secrets.",
  processInput(args: ProcessInputArgs): ProcessInputResult {
    for (const message of args.messages) {
      if (message.role !== "user") continue;
      const text = messageText(message as never);
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(text)) {
          args.abort(
            "Request blocked by prompt-injection guard. Rephrase your Tableau " +
              "worksheet request without instructions to override system behavior.",
          );
        }
      }
    }
    return args.messages;
  },
};
