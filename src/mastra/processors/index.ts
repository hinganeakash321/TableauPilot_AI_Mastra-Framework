/**
 * TableauPilot processors, ordered for input processing.
 */

import { unicodeNormalizer, secretRedactionProcessor } from "./security.js";
import { promptInjectionGuard } from "./validation.js";
import { contextManager } from "./context.js";

/** Input processors run in order before the model sees the prompt. */
export const inputProcessors = [
  unicodeNormalizer,
  promptInjectionGuard,
  contextManager,
  secretRedactionProcessor,
];

/** Output processors run on model output (secret redaction). */
export const outputProcessors = [secretRedactionProcessor];

export {
  unicodeNormalizer,
  secretRedactionProcessor,
  promptInjectionGuard,
  contextManager,
};
