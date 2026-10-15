import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { type AgentCatalog, AgentSelection, keepsConversation } from "../src/agent.ts";
import {
  AgentInstanceConfig,
  AgentInstanceId,
  defaultInstanceConfig,
  deriveInstanceId,
  environmentNameProblem,
  instanceIdProblem,
} from "../src/agentInstance.ts";

const none = new Set<string>();

describe("deriveInstanceId", () => {
  it("prefixes the slug of the label with the kind", () => {
    expect(deriveInstanceId("claude", "Work", none)).toBe("claude_work");
    expect(deriveInstanceId("codex", "  Side  project! ", none)).toBe("codex_side_project");
  });

  it("never takes a default id: the kind's own name gets a suffix", () => {
    expect(deriveInstanceId("claude", "", none)).toBe("claude_2");
    expect(deriveInstanceId("claude", "Claude Code", none)).toBe("claude_2");
    expect(deriveInstanceId("codex", "Codex", new Set(["codex_2"]))).toBe("codex_3");
  });

  it("counts up past ids that exist", () => {
    expect(deriveInstanceId("codex", "x", new Set(["codex_x", "codex_x_2"]))).toBe("codex_x_3");
  });

  it("counts an id taken in another case as taken", () => {
    expect(deriveInstanceId("claude", "Work", new Set(["Claude_Work"]))).toBe("claude_work_2");
  });

  it("keeps a suffixed id within 64 characters", () => {
    const base = `claude_${"a".repeat(48)}`;
    expect(deriveInstanceId("claude", "a".repeat(80), none)).toBe(base);
    const next = deriveInstanceId("claude", "a".repeat(80), new Set([base]));
    expect(next).toBe(`${base}_2`);
    expect(next.length).toBeLessThanOrEqual(64);
  });
});

describe("instanceIdProblem", () => {
  it("takes 64 characters and refuses 65", () => {
    expect(instanceIdProblem(`a${"b".repeat(63)}`, none)).toBeNull();
    expect(instanceIdProblem(`a${"b".repeat(64)}`, none)).toBe(
      "Instance ID must be 64 characters or fewer.",
    );
  });

  it("says what is wrong in the dialog's words", () => {
    expect(instanceIdProblem("", none)).toBe("Instance ID is required.");
    expect(instanceIdProblem("2work", none)).toBe(
      "Instance ID must start with a letter and use only letters, digits, '-', or '_'.",
    );
    expect(instanceIdProblem("claude work", none)).toBe(
      "Instance ID must start with a letter and use only letters, digits, '-', or '_'.",
    );
    expect(instanceIdProblem("claude_work", new Set(["claude_work"]))).toBe(
      "An instance named 'claude_work' already exists.",
    );
  });

  it("keeps the default ids for the defaults, in any case", () => {
    expect(instanceIdProblem("claude", none)).toBe("An instance named 'claude' already exists.");
    expect(instanceIdProblem("codex", none)).toBe("An instance named 'codex' already exists.");
    expect(instanceIdProblem("Claude", none)).toBe("An instance named 'Claude' already exists.");
    expect(instanceIdProblem("CODEX", none)).toBe("An instance named 'CODEX' already exists.");
  });

  it("refuses an id that differs from another only in case", () => {
    expect(instanceIdProblem("Claude_Work", new Set(["claude_work"]))).toBe(
      "An instance named 'Claude_Work' already exists.",
    );
    expect(instanceIdProblem("claude_work", new Set(["CLAUDE_WORK"]))).not.toBeNull();
  });

  it("matches the schema, which trims", () => {
    expect(Schema.decodeUnknownSync(AgentInstanceId)("  codex_work ")).toBe("codex_work");
    expect(() => Schema.decodeUnknownSync(AgentInstanceId)(`a${"b".repeat(64)}`)).toThrow();
  });
});

describe("environmentNameProblem", () => {
  it("refuses what would move the agent off the user's subscription", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "anthropic_auth_token",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_PROFILE",
      "CODEX_API_KEY",
    ])
      expect(environmentNameProblem(name), name).toContain("off your subscription");
  });

  it("refuses what prkit sets itself or what crosses accounts", () => {
    expect(environmentNameProblem("HOME")).toContain("keychain");
    expect(environmentNameProblem("PATH")).toContain("sandbox");
    expect(environmentNameProblem("CLAUDE_CONFIG_DIR")).toBe(
      "Use the Config folder field instead.",
    );
    expect(environmentNameProblem("CODEX_HOME")).toBe("Use the Config folder field instead.");
    expect(environmentNameProblem("GH_TOKEN")).toContain("GitHub accounts");
    expect(environmentNameProblem("GITHUB_TOKEN")).toContain("GitHub accounts");
    expect(environmentNameProblem("PRKIT_AUTH_TOKEN")).toContain("prkit sets");
    expect(environmentNameProblem("NODE_OPTIONS")).toContain("run code");
    expect(environmentNameProblem("DYLD_INSERT_LIBRARIES")).toContain("run code");
  });

  it("refuses whole agent and runtime namespaces, not only the names known today", () => {
    for (const name of [
      "CLAUDE_CODE_PLUGIN_DIRS",
      "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
      "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
      "CLAUDE_ENV_FILE",
      "CLAUDE_CODE_SHELL",
      "CLAUDE_CODE_SHELL_PREFIX",
      "CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT",
      "claude_anything_new",
      "CODEX_SANDBOX",
      "CODEX_ANYTHING_NEW",
    ])
      expect(environmentNameProblem(name), name).toContain("changes how the agent runs");
    for (const name of [
      "BUN_OPTIONS",
      "BUN_INSPECT",
      "BUN_INSPECT_CONNECT_TO",
      "NODE_EXTRA_CA_CERTS",
    ])
      expect(environmentNameProblem(name), name).toContain("runtime");
    for (const name of ["ANTHROPIC_CUSTOM_HEADERS", "OPENAI_ORG_ID"])
      expect(environmentNameProblem(name), name).toContain("off your subscription");
  });

  it("takes ordinary names and refuses malformed ones", () => {
    expect(environmentNameProblem("HTTPS_PROXY")).toBeNull();
    expect(environmentNameProblem("_MY_FLAG2")).toBeNull();
    expect(environmentNameProblem("2FAST")).toContain("letters, digits");
    expect(environmentNameProblem("MY-FLAG")).toContain("letters, digits");
  });
});

describe("AgentInstanceConfig paths", () => {
  const decode = Schema.decodeUnknownSync(AgentInstanceConfig);
  const config = (configDir: string, binaryPath: string | null = null) => ({
    ...defaultInstanceConfig("claude"),
    configDir,
    binaryPath,
  });

  it("takes absolute paths and paths under ~/", () => {
    expect(decode(config("/Users/octocat/.claude-work")).configDir).toBe(
      "/Users/octocat/.claude-work",
    );
    expect(decode(config("~/.claude-work", "~/bin/claude")).binaryPath).toBe("~/bin/claude");
  });

  it("refuses relative paths and a bare ~", () => {
    for (const path of [".claude-work", "~", "~octocat/.claude", "bin/claude"])
      expect(() => decode(config(path)), path).toThrow();
    expect(() => decode(config("/Users/octocat/.claude", "claude"))).toThrow();
  });
});

describe("AgentSelection", () => {
  it("reads a selection saved by kind as that kind's default instance", () => {
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(AgentSelection))(
        '{"provider":"codex","model":"gpt-6.1","options":[]}',
      ),
    ).toEqual({ instance: "codex", model: "gpt-6.1", options: [] });
  });

  it("saves by instance", () => {
    const selection = Schema.decodeUnknownSync(AgentSelection)({
      instance: "claude_work",
      model: "claude-fable-5-1",
      options: [],
    });
    expect(Schema.encodeSync(Schema.fromJsonString(AgentSelection))(selection)).toBe(
      '{"instance":"claude_work","model":"claude-fable-5-1","options":[]}',
    );
  });
});

describe("keepsConversation", () => {
  const entry = (instance: string, group: string) => ({
    instance: AgentInstanceId.make(instance),
    kind: "claude" as const,
    label: instance,
    accent: null,
    enabled: true,
    isDefault: instance === "claude",
    configDir: null,
    binaryPath: null,
    environment: [],
    login: "shared" as const,
    group,
    version: null,
    state: { _tag: "ready" as const, detail: "", ownLogin: false },
    models: [],
  });
  const catalog: AgentCatalog = {
    providers: [
      entry("claude", "claude:/Users/octocat/.claude"),
      entry("claude_same", "claude:/Users/octocat/.claude"),
      entry("claude_work", "claude:/Users/octocat/.claude-work"),
    ],
  };

  it("keeps it within a group and starts over across groups", () => {
    expect(keepsConversation(catalog, "claude", "claude")).toBe(true);
    expect(keepsConversation(catalog, "claude", "claude_same")).toBe(true);
    expect(keepsConversation(catalog, "claude", "claude_work")).toBe(false);
    expect(keepsConversation(catalog, "claude_work", "claude")).toBe(false);
  });

  it("keeps nothing from an instance that is gone", () => {
    expect(keepsConversation(catalog, "claude_gone", "claude")).toBe(false);
  });
});
