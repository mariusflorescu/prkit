const REDACTED = "[redacted]";

/**
 * Every secret shape prkit could meet in a log line. A value is replaced and its key stays, so
 * the line still says what was there. Running it twice changes nothing.
 */
const RULES = [
  // The value of an Authorization header or field: plain, quoted, or quoted inside an escaped string.
  [
    /(authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"'\\,;}&]+/gi,
    `$1${REDACTED}`,
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED],
  // A word after "token" is prose ("token expired") unless it is long enough to be a credential.
  [/\btoken\s+[A-Za-z0-9._~+/=-]{16,}/gi, REDACTED],
  // The UI's per-launch token, and any other `token=` parameter.
  [/(token=)[^&\s"'\\]+/gi, `$1${REDACTED}`],
  [/(:\/\/)[^\s/@:]+:[^\s/@]+@/g, `$1${REDACTED}@`],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // prkit's own secrets are 32 random bytes in hex. A 40-hex commit sha is not one.
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi, REDACTED],
] as const;

export const redactSecrets = (text: string): string =>
  RULES.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);
