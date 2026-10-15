import type { AgentCatalogEntry, AgentInstanceConfig } from "@prkit/contracts";

/** An instance's settings as the catalog shows them, ready to send back changed. */
export const configOf = (entry: AgentCatalogEntry): AgentInstanceConfig => ({
  id: entry.instance,
  kind: entry.kind,
  label: entry.label,
  accent: entry.accent,
  enabled: entry.enabled,
  configDir: entry.configDir,
  binaryPath: entry.binaryPath,
  environment: entry.environment,
  login: entry.login,
});
