/** Each caller supplies only the extra variables its child needs. */
export const childEnv = (
  source: Readonly<Record<string, string | undefined>>,
  extras: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (BASE_KEYS.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
};

const BASE_KEYS = new Set(["HOME", "USER", "PATH", "SHELL", "LANG", "TMPDIR", "TERM"]);
