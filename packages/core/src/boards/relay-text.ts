// Ruling 15b and Ruling 24: any relay-supplied string that reaches a log line (a NOTICE, a CLOSED
// reason, an error message derived from either) is untrusted and unbounded, and so is the text of
// an error thrown by a subscription handler. Control characters are blanked, so a relay cannot
// forge log lines or drive a terminal, and the result is capped well under typical log-line limits.
// Internal to the boards modules: index.ts does not re-export this file.
export function sanitizeRelayText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200)
}
