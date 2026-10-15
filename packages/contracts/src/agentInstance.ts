import * as Schema from "effect/Schema";

/** The agents prkit can run. Each kind's default instance has the kind as its id. */
export const AGENT_KINDS = ["claude", "codex", "cursor"] as const;
export const AgentProviderKind = Schema.Literals(AGENT_KINDS);
export type AgentProviderKind = typeof AgentProviderKind.Type;

/** What each kind is called: `name` for the product, `short` for model names ("Claude Opus 5.5"). */
export const AGENT_KIND_NAMES: Readonly<
  Record<AgentProviderKind, { readonly name: string; readonly short: string }>
> = {
  claude: { name: "Claude Code", short: "Claude" },
  codex: { name: "Codex", short: "Codex" },
  cursor: { name: "Cursor", short: "Cursor" },
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
/** Ids are unique whatever their case, so `Claude` or `CODEX` would pass for a default. */
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** `id` is a default's id in some case: no added instance may take it. */
export const isReservedInstanceId = (id: string) => AGENT_KINDS.some((kind) => sameId(kind, id));
const idTaken = (id: string, existing: ReadonlySet<string>) =>
  isReservedInstanceId(id) || [...existing].some((other) => sameId(other, id));

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

/** Why a folder or binary path can't be used, in words for the form, or null. */
export const agentPathProblem = (path: string) =>
  path.startsWith("/") || path.startsWith("~/") ? null : "Use a full path, starting with / or ~/.";

/** An absolute path, or one under the user's home (`~/`), which prkit expands. */
export const AgentPath = Schema.String.check(
  Schema.makeFilter((path) => agentPathProblem(path) ?? true),
);

export const AgentLogin = Schema.Literals(["shared", "prkit"]);
export type AgentLogin = typeof AgentLogin.Type;

/** An instance's settings, as the app edits them. Sensitive values arrive redacted. */
export const AgentInstanceConfig = Schema.Struct({
  id: AgentInstanceId,
  kind: AgentProviderKind,
  label: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  accent: Schema.NullOr(AgentAccent),
  enabled: Schema.Boolean,
  /**
   * CLAUDE_CONFIG_DIR or CODEX_HOME; null for the agent's own default folder. `~` is expanded.
   * Always null for Cursor, which runs in a folder of prkit's own.
   */
  configDir: Schema.NullOr(AgentPath),
  /** Null finds the agent on PATH. Always null for Cursor, which prkit runs through its SDK. */
  binaryPath: Schema.NullOr(AgentPath),
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
  if (idTaken(id, existing)) return `An instance named '${id}' already exists.`;
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
  const taken = (id: string) => idTaken(id, existing);
  if (!taken(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const end = `_${suffix}`;
    const candidate = `${base.slice(0, INSTANCE_ID_MAX - end.length)}${end}`;
    if (!taken(candidate)) return candidate;
  }
};

/**
 * Variables an instance may not set, and why: they would switch the agent off the user's
 * subscription, cross GitHub accounts, reach prkit's own secrets, or change how the agent or its
 * runtime starts. Whole namespaces go, since Claude Code, Codex, Bun and Node add new settings
 * all the time and any of them could load code or settings from outside prkit's sandbox.
 */
const BLOCKED_ENV: ReadonlyArray<{
  readonly test: (name: string) => boolean;
  readonly why: string;
}> = [
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
  {
    test: (name) => /^(CLAUDE|CODEX)_/.test(name),
    why: "It changes how the agent runs: settings, plugins, shells or logins from outside prkit. Use the Config folder field to point the agent at another setup.",
  },
  {
    // The one exception: a CA file for a corporate proxy, which runs no code.
    test: (name) => /^(BUN|NODE)_/.test(name) && name !== "NODE_EXTRA_CA_CERTS",
    why: "It changes how the agent's runtime starts, and could load code around prkit's sandbox.",
  },
];

/**
 * The one Cursor variable an instance may set: a Cursor API key, in place of signing in. Every
 * Cursor key bills the user's own plan, so it stays on the subscription; a custom endpoint would
 * not, and is refused with the rest of `CURSOR_`.
 */
const CURSOR_API_KEY = "CURSOR_API_KEY";

/**
 * Why an instance of `kind` can't set `name`, in words for the form, or null when it can.
 * `sensitive` says whether the value is kept as a secret.
 */
export const environmentNameProblem = (
  name: string,
  kind: AgentProviderKind,
  sensitive: boolean,
) => {
  if (name.length === 0) return "Name the variable.";
  if (name.length > 128) return "Variable names are 128 characters or fewer.";
  if (!ENV_NAME_PATTERN.test(name))
    return "Use letters, digits and '_', starting with a letter or '_'.";
  const upper = name.toUpperCase();
  if (upper === CURSOR_API_KEY) {
    if (kind !== "cursor") return "Only a Cursor agent uses a Cursor API key.";
    if (name !== CURSOR_API_KEY) return `Write it as ${CURSOR_API_KEY}.`;
    return sensitive ? null : "Mark it Sensitive, so prkit keeps the key out of its database.";
  }
  if (upper.startsWith("CURSOR_"))
    return "It changes how Cursor runs: its servers, settings or login from outside prkit. Only CURSOR_API_KEY is allowed, on a Cursor agent.";
  return BLOCKED_ENV.find((rule) => rule.test(upper))?.why ?? null;
};
