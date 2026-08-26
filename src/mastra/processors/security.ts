/**
 * Security processors (spec sections 56, 70, 83).
 *
 * - `unicodeNormalizer`: normalizes/strips control characters on input (also a
 *   defense against unicode-based prompt injection).
 * - `secretRedactionProcessor`: redacts secret-looking content on BOTH input and
 *   output so credentials never reach the model, memory, traces, or tool output.
 */

import {
  RegexFilterProcessor,
  UnicodeNormalizer,
} from "@mastra/core/processors";

/** Input normalization (control chars stripped, whitespace collapsed). */
export const unicodeNormalizer = new UnicodeNormalizer({
  stripControlChars: true,
  collapseWhitespace: true,
});

/**
 * Redacts secret-looking tokens. Applied to input and output phases. `redact`
 * (not `block`) so legitimate requests continue with secrets removed.
 */
export const secretRedactionProcessor = new RegexFilterProcessor({
  strategy: "redact",
  rules: [
    { name: "openrouter-key", pattern: /sk-or-v1-[A-Za-z0-9]{10,}/g },
    { name: "sk-key", pattern: /sk-[A-Za-z0-9-_]{10,}/g },
    { name: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._-]{10,}/gi },
    {
      name: "tableau-auth",
      pattern: /X-Tableau-Auth['":\s]+[A-Za-z0-9._-]{10,}/gi,
    },
    {
      name: "pat-secret",
      pattern: /(pat[_-]?secret|personalaccesstokensecret)['":=\s]+[A-Za-z0-9._-]{6,}/gi,
    },
  ],
});
