import * as Schema from "effect/Schema";

/** The agents prkit can run. Each kind's default instance has the kind as its id. */
export const AGENT_KINDS = ["claude", "codex"] as const;
export const AgentProviderKind = Schema.Literals(AGENT_KINDS);
export type AgentProviderKind = typeof AgentProviderKind.Type;

/** What each kind is called: `name` for the product, `short` for model names ("Claude Opus 5.5"). */
export const AGENT_KIND_NAMES: Readonly<
  Record<AgentProviderKind, { readonly name: string; readonly short: string }>
> = {
  claude: { name: "Claude Code", short: "Claude" },
  codex: { name: "Codex", short: "Codex" },
};

const INSTANCE_ID_MAX = 64;
const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENV_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * One setup of an agent: its own config folder, binary and sign-in. The routing key for
 * reviews, fix sessions and selections. Letters, digits, `-` and `_`, starting with a letter.
 */
export const AgentInstanceId = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(INSTANCE_ID_MAX),
  Schema.isPattern(INSTANCE_ID_PATTERN),
).pipe(Schema.brand("AgentInstanceId"));
export type AgentInstanceId = typeof AgentInstanceId.Type;

/** The instance that always exists for `kind`: it can be renamed, turned off and reset, never removed. */
export const defaultInstanceId = (kind: AgentProviderKind) => AgentInstanceId.make(kind);
export const isDefaultInstance = (id: string) => AGENT_KINDS.some((kind) => kind === id);

/** `#rrggbb`, the user's own marker for an instance. */
export const AgentAccent = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

export const AgentEnvironmentName = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(ENV_NAME_PATTERN),
);

export const AgentEnvironmentVariable = Schema.Struct({
  name: AgentEnvironmentName,
  /** Empty for a sensitive value the server keeps: the app never gets it back. */
  value: Schema.String,
  /** Stored apart from the database and never sent back to the app. */
  sensitive: Schema.Boolean,
  /** The server holds a value for this sensitive variable that it doesn't send. */
  valueRedacted: Schema.Boolean,
});
export type AgentEnvironmentVariable = typeof AgentEnvironmentVariable.Type;

export const AgentLogin = Schema.Literals(["shared", "prkit"]);
export type AgentLogin = typeof AgentLogin.Type;

/** An instance's settings, as the app edits them. Sensitive values arrive redacted. */
export const AgentInstanceConfig = Schema.Struct({
  id: AgentInstanceId,
  kind: AgentProviderKind,
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  accent: Schema.NullOr(AgentAccent),
  enabled: Schema.Boolean,
  /** CLAUDE_CONFIG_DIR or CODEX_HOME; null for the agent's own default folder. `~` is expanded. */
  configDir: Schema.NullOr(Schema.String),
  /** Null finds the agent on PATH. */
  binaryPath: Schema.NullOr(Schema.String),
  environment: Schema.Array(AgentEnvironmentVariable),
  /**
   * Codex only. `shared` runs on the login of the instance's Codex home; `prkit` keeps a ChatGPT
   * login of the instance's own, which prkit signs in and out ("Sign in with ChatGPT").
   */
  login: AgentLogin,
});
export type AgentInstanceConfig = typeof AgentInstanceConfig.Type;

export class AgentInstanceError extends Schema.TaggedError<AgentInstanceError>()(
  "AgentInstanceError",
  { message: Schema.String },
) {}

/** The built-in instance of `kind`, before the user changes anything. */
export const defaultInstanceConfig = (kind: AgentProviderKind): AgentInstanceConfig => ({
  id: defaultInstanceId(kind),
  kind,
  label: AGENT_KIND_NAMES[kind].short,
  accent: null,
  enabled: true,
  configDir: null,
  binaryPath: null,
  environment: [],
  login: "shared",
});

/** Why `id` can't name a new instance, in the words the Add agent dialog shows, or null. */
export const instanceIdProblem = (id: string, existing: ReadonlySet<string>) => {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > INSTANCE_ID_MAX) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id))
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  if (existing.has(id) || isDefaultInstance(id)) return `An instance named '${id}' already exists.`;
  return null;
};

const slugifyLabel = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

/**
 * The id a new instance gets from its label: `${kind}_${slug}`, or the bare kind for an empty
 * label or the kind's own name, then `_2`, `_3`... until it is free. Default ids are always taken.
 */
export const deriveInstanceId = (
  kind: AgentProviderKind,
  label: string,
  existing: ReadonlySet<string>,
) => {
  const slug = slugifyLabel(label);
  const names = AGENT_KIND_NAMES[kind];
  const base =
    slug === "" || label.trim() === names.name || label.trim() === names.short
      ? kind
      : `${kind}_${slug}`;
  const taken = (id: string) => existing.has(id) || isDefaultInstance(id);
  if (!taken(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const end = `_${suffix}`;
    const candidate = `${base.slice(0, INSTANCE_ID_MAX - end.length)}${end}`;
    if (!taken(candidate)) return candidate;
  }
};

/**
 * Variables an instance may not set, and why. prkit builds every agent's environment from an
 * allowlist; these would undo that: switch the agent off the user's subscription, cross GitHub
 * accounts, reach prkit's own secrets, or run code around prkit's sandbox.
 */
const BLOCKED_ENV: ReadonlyArray<{ readonly test: (name: string) => boolean; readonly why: string }> =
  [
    {
      test: (name) => name === "HOME",
      why: "prkit never changes HOME for an agent: the agent would lose its keychain login.",
    },
    {
      test: (name) => ["PATH", "USER", "SHELL", "TMPDIR", "DEVELOPER_DIR"].includes(name),
      why: "prkit sets this itself for every agent, to keep its commands in the sandbox.",
    },
    {
      test: (name) => name === "CLAUDE_CONFIG_DIR" || name === "CODEX_HOME",
      why: "Use the Config folder field instead.",
    },
    {
      test: (name) =>
        /^(ANTHROPIC|OPENAI|AZURE|AWS|GOOGLE|VERTEX|CLOUD_ML|BEDROCK|GEMINI)_/.test(name) ||
        /^CLAUDE_CODE_(USE|OAUTH|API_KEY)/.test(name) ||
        /^CODEX_(API_KEY|.*BASE_URL)/.test(name),
      why: "It would switch the agent off your subscription to an API key or another provider.",
    },
    {
      test: (name) => /^(GH|GITHUB)_/.test(name),
      why: "It would switch GitHub accounts.",
    },
    {
      test: (name) => /^(PRKIT|GIT)_/.test(name),
      why: "prkit sets these itself.",
    },
    {
      test: (name) =>
        ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "ZDOTDIR"].includes(name) ||
        /^(DYLD|LD)_/.test(name) ||
        /^CLAUDE_(CODE_TMPDIR|AGENT_SDK)/.test(name) ||
        name === "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
      why: "It could run code or change settings around prkit's sandbox.",
    },
  ];

/** Why an instance can't set `name`, in words for the form, or null when it can. */
export const environmentNameProblem = (name: string) => {
  if (name.length === 0) return "Name the variable.";
  if (name.length > 128) return "Variable names are 128 characters or fewer.";
  if (!ENV_NAME_PATTERN.test(name))
    return "Use letters, digits and '_', starting with a letter or '_'.";
  const upper = name.toUpperCase();
  return BLOCKED_ENV.find((rule) => rule.test(upper))?.why ?? null;
};
