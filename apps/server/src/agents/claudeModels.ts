import {
  type AgentModel,
  type ModelOptionDescriptor,
  type ModelOptionSelection,
  resolveModelOptions,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

/**
 * Claude Code has no model list to ask, so prkit ships one. Effort levels come
 * from each model's profile. Multi-agent orchestration is left out: prkit's agent
 * gets no tools to delegate with.
 */
interface ClaudeModel {
  readonly slug: string;
  readonly name: string;
  readonly minVersion: string;
  readonly isDefault: boolean;
  readonly options: ReadonlyArray<ModelOptionDescriptor>;
  /** Effort values Claude Code takes under another name, or not at all (null). */
  readonly effortMap: Readonly<Record<string, string | null>>;
}

const effort = (defaultEffort: string): ModelOptionDescriptor => ({
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low", ...(defaultEffort === "low" ? { isDefault: true } : {}) },
    { id: "medium", label: "Medium", ...(defaultEffort === "medium" ? { isDefault: true } : {}) },
    { id: "high", label: "High", ...(defaultEffort === "high" ? { isDefault: true } : {}) },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    {
      id: "ultrathink",
      label: "Ultrathink",
      description: "Asks for the deepest thinking in the prompt",
    },
  ],
  promptInjectedValues: ["ultrathink"],
});
const FAST_MODE: ModelOptionDescriptor = { id: "fastMode", label: "Fast Mode", type: "boolean" };

const MODELS: ReadonlyArray<ClaudeModel> = [
  {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    minVersion: "2.1.257",
    isDefault: true,
    options: [effort("medium")],
    effortMap: { ultrathink: null },
  },
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    minVersion: "2.1.280",
    isDefault: false,
    options: [effort("medium"), FAST_MODE],
    effortMap: { ultrathink: null },
  },
  {
    slug: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    minVersion: "2.1.284",
    isDefault: false,
    options: [effort("high")],
    effortMap: { ultrathink: null },
  },
  {
    slug: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    minVersion: "2.1.293",
    isDefault: false,
    options: [effort("medium")],
    effortMap: { ultrathink: null },
  },
];

const parseVersion = (text: string) =>
  /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1, 4).map(Number) ?? null;

const atLeast = (version: ReadonlyArray<number>, minimum: ReadonlyArray<number>) => {
  for (let index = 0; index < minimum.length; index++) {
    const have = version[index] ?? 0;
    const need = minimum[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
};

/** The bundled models, each blocked when the installed Claude Code is too old for it. */
export const claudeModels = (installedVersion: string | null): ReadonlyArray<AgentModel> => {
  const version = installedVersion === null ? null : parseVersion(installedVersion);
  return MODELS.map((model) => {
    const minimum = parseVersion(model.minVersion);
    const tooOld = version !== null && minimum !== null && !atLeast(version, minimum);
    return {
      slug: model.slug,
      name: model.name,
      description: null,
      isDefault: model.isDefault,
      options: model.options,
      blocked: tooOld
        ? `${model.name} needs Claude Code ${model.minVersion} or newer. Run claude update.`
        : null,
    };
  });
};

const isEffortLevel = Schema.is(Schema.Literals(["low", "medium", "high", "xhigh", "max"]));

/** A selection as Claude Code takes it: SDK options plus a word for the prompt. */
export const compileClaudeSelection = (
  slug: string,
  selections: ReadonlyArray<ModelOptionSelection>,
) => {
  const model = MODELS.find((entry) => entry.slug === slug);
  if (model === undefined)
    return { model: slug, effort: undefined, fastMode: undefined, promptPrefix: "" };
  const resolved = resolveModelOptions(model.options, selections);
  const chosen = resolved.find((option) => option.descriptor.id === "effort");
  const rawEffort = chosen?.type === "select" ? chosen.value : undefined;
  const mapped =
    rawEffort !== undefined && Object.hasOwn(model.effortMap, rawEffort)
      ? model.effortMap[rawEffort]
      : rawEffort;
  const fast = resolved.find((option) => option.descriptor.id === "fastMode");
  const injected =
    chosen?.type === "select" &&
    (chosen.descriptor.promptInjectedValues ?? []).includes(chosen.value);
  return {
    model: model.slug,
    effort: isEffortLevel(mapped) ? mapped : undefined,
    fastMode: fast?.type === "boolean" ? fast.value : undefined,
    // Claude Code reads "ultrathink" as a word in the prompt.
    promptPrefix: injected ? "Ultrathink:\n" : "",
  };
};
