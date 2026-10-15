import {
  type AgentCatalogEntry,
  type AgentInstanceConfig,
  type AgentProviderKind,
  agentPathProblem,
} from "@prkit/contracts";

/** What the edit form holds: paths as typed, empty for the agent's own default. */
export interface InstanceFormValues {
  label: string;
  accent: string | null;
  binaryPath: string;
  configDir: string;
  environment: Array<{ name: string; value: string; sensitive: boolean; valueRedacted: boolean }>;
}

export const formValuesOf = (entry: AgentCatalogEntry): InstanceFormValues => ({
  label: entry.label,
  accent: entry.accent,
  binaryPath: entry.binaryPath ?? "",
  configDir: entry.configDir ?? "",
  environment: entry.environment.map((variable) => ({ ...variable })),
});

const blank = (value: string) => (value.trim() === "" ? null : value.trim());

/** The form's values on top of the instance's other settings, as the server takes them. */
export const configFrom = (
  config: AgentInstanceConfig,
  values: InstanceFormValues,
): AgentInstanceConfig => ({
  ...config,
  label: values.label.trim(),
  accent: values.accent,
  configDir: config.login === "prkit" || config.kind === "cursor" ? null : blank(values.configDir),
  binaryPath: config.kind === "cursor" ? null : blank(values.binaryPath),
  environment: values.environment.map((variable) => ({
    name: variable.name.trim(),
    value: variable.value,
    sensitive: variable.sensitive,
    // Left empty, a saved sensitive value stays as it is.
    valueRedacted: variable.sensitive && variable.valueRedacted && variable.value === "",
  })),
});

/** An absolute path, or one starting with `~/`. */
export const pathProblem = (value: string) =>
  value.trim() === "" ? true : (agentPathProblem(value.trim()) ?? true);

/**
 * Each kind's binary and folder fields: what they're called and why they matter. Cursor has
 * neither: prkit runs it through its SDK, in a folder of its own.
 */
export const KIND_FIELDS: Record<
  Exclude<AgentProviderKind, "cursor">,
  {
    readonly binary: string;
    readonly folder: {
      readonly label: string;
      readonly placeholder: string;
      readonly hint: string;
    };
  }
> = {
  claude: {
    binary: "claude",
    folder: {
      label: "Config folder (CLAUDE_CONFIG_DIR)",
      placeholder: "~/.claude",
      hint: "Where this Claude Code keeps its login and sessions. Spell it the way you signed in with it: Claude Code names its keychain login after the exact text, so a trailing slash or a path through a symlink is another login. prkit expands ~ the way your shell does.",
    },
  },
  codex: {
    binary: "codex",
    folder: {
      label: "Codex home (CODEX_HOME)",
      placeholder: "~/.codex",
      hint: "The Codex home whose login this agent uses. prkit runs Codex in a folder of its own that shares that login.",
    },
  },
};
