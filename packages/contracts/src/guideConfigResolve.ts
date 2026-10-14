import type { DiffFile, DiffSnapshot } from "./diffSnapshot.ts";
import type {
  EffectiveFocusArea,
  EffectiveGuidance,
  EffectiveIgnoreRule,
  GuideItemId,
  GuideScopeName,
  ResolvedGuideConfig,
  ScopeConfig,
  SkippedFile,
} from "./guideConfig.ts";

/** The scopes that apply, least specific first. A missing one contributes nothing. */
export interface GuideConfigLayers {
  readonly global: ScopeConfig;
  readonly repository: ScopeConfig | null;
  readonly pullRequest: ScopeConfig | null;
}

export const SCOPE_LABELS: Record<GuideScopeName, string> = {
  global: "Global",
  repository: "Repository",
  "pull-request": "This pull request",
};

type Layer = { readonly scope: GuideScopeName; readonly config: ScopeConfig };
type ItemKind = "ignore" | "focus";

const layersOf = (input: GuideConfigLayers): ReadonlyArray<Layer> => [
  { scope: "global", config: input.global },
  ...(input.repository === null
    ? []
    : [{ scope: "repository" as const, config: input.repository }]),
  ...(input.pullRequest === null
    ? []
    : [{ scope: "pull-request" as const, config: input.pullRequest }]),
];

const itemIds = (config: ScopeConfig, kind: ItemKind): ReadonlyArray<GuideItemId> =>
  kind === "ignore"
    ? config.ignore.rules.map((rule) => rule.id)
    : config.focus.areas.map((area) => area.id);

/** The most specific explicit on/off below the item's own scope wins; no override means on. */
const stateOf = (
  layers: ReadonlyArray<Layer>,
  owner: number,
  kind: ItemKind,
  id: GuideItemId,
): { readonly active: boolean; readonly decidedBy: GuideScopeName | null } => {
  for (let index = layers.length - 1; index > owner; index--) {
    const layer = layers[index];
    const override = layer?.config[kind].overrides.find((entry) => entry.itemId === id);
    if (layer !== undefined && override !== undefined)
      return { active: override.value === "on", decidedBy: layer.scope };
  }
  return { active: true, decidedBy: null };
};

const handleOf = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "area";

/** FNV-1a, 64 bits: a stable fingerprint for "did the settings change", not a secret. */
const fingerprint = (text: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

/** Only what reaches the guide counts: items switched off and dropped guidance don't. */
const hashOf = (
  ignore: ReadonlyArray<EffectiveIgnoreRule>,
  focusAreas: ReadonlyArray<EffectiveFocusArea>,
  guidance: ReadonlyArray<EffectiveGuidance>,
) =>
  fingerprint(
    JSON.stringify([
      ignore.filter((rule) => rule.active).map((rule) => rule.pattern),
      focusAreas
        .filter((area) => area.active)
        .map((area) => [area.handle, area.label, area.question]),
      guidance
        .filter((block) => block.replacedBy === null)
        .map((block) => [block.scope, block.text]),
    ]),
  );

/**
 * Resolves the scopes into what one pull request's guide uses (docs/internals/architecture.md
 * "Guide settings"). Pure, so the preview and the attempt agree.
 */
export const resolveGuideConfig = (input: GuideConfigLayers): ResolvedGuideConfig => {
  const layers = layersOf(input);
  const ignore = layers.flatMap((layer, owner) =>
    layer.config.ignore.rules.map((rule): EffectiveIgnoreRule => ({
      id: rule.id,
      pattern: rule.pattern,
      scope: layer.scope,
      ...stateOf(layers, owner, "ignore", rule.id),
    })),
  );
  const taken = new Set<string>();
  const focusAreas = layers.flatMap((layer, owner) =>
    layer.config.focus.areas.map((area): EffectiveFocusArea => {
      const state = stateOf(layers, owner, "focus", area.id);
      if (!state.active) return { ...area, scope: layer.scope, ...state, handle: null };
      const base = handleOf(area.label);
      let handle = base;
      for (let suffix = 2; taken.has(handle); suffix++) handle = `${base}-${suffix}`;
      taken.add(handle);
      return { ...area, scope: layer.scope, ...state, handle };
    }),
  );
  const replacing = layers.findLastIndex((layer) => layer.config.guidance.mode === "replace");
  const replacer = layers[replacing]?.scope ?? null;
  const guidance = layers.flatMap((layer, index): ReadonlyArray<EffectiveGuidance> => {
    const text = layer.config.guidance.text.trim();
    if (text === "") return [];
    return [{ scope: layer.scope, text, replacedBy: index < replacing ? replacer : null }];
  });
  const dangling = layers.flatMap((layer, index) =>
    (["ignore", "focus"] as const).flatMap((kind) =>
      layer.config[kind].overrides
        .filter(
          (override) =>
            !layers
              .slice(0, index)
              .some((parent) => itemIds(parent.config, kind).includes(override.itemId)),
        )
        .map((override) => ({ scope: layer.scope, kind, itemId: override.itemId })),
    ),
  );
  return { ignore, focusAreas, guidance, dangling, hash: hashOf(ignore, focusAreas, guidance) };
};

// Ignore patterns: repository-relative and case-sensitive. A rule that matches a folder
// matches everything inside it, but a later `!` rule can still keep one of those files:
// unlike git, a skipped folder doesn't hide its contents from later rules.

interface ParsedPattern {
  /** `!pattern`: a match keeps the file. */
  readonly keep: boolean;
  /** `folder/`: matches folders only, so everything inside them. */
  readonly folderOnly: boolean;
  /** Contains a `/` before its end, or starts with one: matched from the repository root. */
  readonly rooted: boolean;
  readonly body: string;
}

const parsePattern = (pattern: string): ParsedPattern => {
  const keep = pattern.startsWith("!");
  const unnegated = keep ? pattern.slice(1) : pattern;
  const folderOnly = unnegated.endsWith("/");
  const trimmed = unnegated.replace(/\/+$/, "");
  const body = trimmed.replace(/^\/+/, "");
  return { keep, folderOnly, rooted: body !== trimmed || body.includes("/"), body };
};

const unclosedClass = (body: string) => {
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== "[") continue;
    let end = index + 1;
    if (body[end] === "!" || body[end] === "^") end++;
    if (body[end] === "]") end++;
    while (end < body.length && body[end] !== "]") end++;
    if (end >= body.length) return true;
    index = end;
  }
  return false;
};

/** Why a pattern can't be used, in words for the reviewer, or null when it can. */
export const ignorePatternProblem = (pattern: string): string | null => {
  if (pattern.trim() !== pattern) return "Remove the spaces at the start or end.";
  if (pattern.length > 200) return "Keep a pattern under 200 characters.";
  const { body } = parsePattern(pattern);
  if (body === "") return "Add a file, folder or glob, like `dist/` or `*.snap`.";
  if (body.includes("\\")) return "Use `/` between folders.";
  const segments = body.split("/");
  if (segments.some((segment) => segment === "")) return "Remove the doubled `/`.";
  if (segments.some((segment) => segment === "." || segment === ".."))
    return "Patterns start at the repository root, so leave out `.` and `..`.";
  if (unclosedClass(body)) return "Close the `[` with a `]`.";
  return null;
};

const escape = (char: string) => char.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** `**` crosses folders, `*` and `?` stay inside one, `[...]` is a character class. */
const globSource = (glob: string) => {
  let source = "";
  for (let index = 0; index < glob.length;) {
    if (glob.startsWith("**/", index)) {
      source += "(?:[^/]*/)*";
      index += 3;
    } else if (glob.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (glob[index] === "*") {
      source += "[^/]*";
      index++;
    } else if (glob[index] === "?") {
      source += "[^/]";
      index++;
    } else if (glob[index] === "[") {
      let end = index + 1;
      const negated = glob[end] === "!" || glob[end] === "^";
      if (negated) end++;
      let members = "";
      if (glob[end] === "]") {
        members += "\\]";
        end++;
      }
      while (end < glob.length && glob[end] !== "]") {
        const char = glob[end] ?? "";
        members += char === "\\" || char === "^" || char === "[" ? `\\${char}` : char;
        end++;
      }
      source += negated ? `[^/${members}]` : `[${members}]`;
      index = end + 1;
    } else {
      source += escape(glob[index] ?? "");
      index++;
    }
  }
  return source;
};

interface CompiledRule {
  readonly rule: EffectiveIgnoreRule;
  readonly parsed: ParsedPattern;
  readonly regex: RegExp;
}

/** A rooted pattern matches a leading part of the path; any other matches one of its names. */
const matchesPath = (compiled: CompiledRule, path: string) => {
  const segments = path.split("/");
  for (let count = 1; count <= segments.length; count++) {
    if (compiled.parsed.folderOnly && count === segments.length) continue;
    const candidate = compiled.parsed.rooted
      ? segments.slice(0, count).join("/")
      : (segments[count - 1] ?? "");
    if (compiled.regex.test(candidate)) return true;
  }
  return false;
};

export interface PathDecision {
  readonly path: string;
  /** Every rule that matches the path, on or off, in effective order. */
  readonly matches: ReadonlyArray<EffectiveIgnoreRule>;
  /** The last matching rule that is on; it decides. Null keeps the path: no rule matched. */
  readonly winner: EffectiveIgnoreRule | null;
  readonly skipped: boolean;
}

export interface FileDecision {
  readonly path: string;
  readonly previousPath: string | null;
  /** The new path, then the old path of a rename. */
  readonly sides: ReadonlyArray<PathDecision>;
  /** A rename is skipped only when both its paths are. */
  readonly skipped: boolean;
}

export const isKeepPattern = (pattern: string) => pattern.startsWith("!");

/** One matcher for the composer preview and for generation. */
export const ignoreMatcher = (rules: ReadonlyArray<EffectiveIgnoreRule>) => {
  const compiled = rules.flatMap((rule): ReadonlyArray<CompiledRule> => {
    if (ignorePatternProblem(rule.pattern) !== null) return [];
    const parsed = parsePattern(rule.pattern);
    return [{ rule, parsed, regex: new RegExp(`^${globSource(parsed.body)}$`, "u") }];
  });
  const decidePath = (path: string): PathDecision => {
    const matched = compiled.filter((entry) => matchesPath(entry, path));
    const winner = matched.findLast((entry) => entry.rule.active);
    return {
      path,
      matches: matched.map((entry) => entry.rule),
      winner: winner?.rule ?? null,
      skipped: winner !== undefined && !winner.parsed.keep,
    };
  };
  return (file: { readonly path: string; readonly previousPath: string | null }): FileDecision => {
    const sides = [
      decidePath(file.path),
      ...(file.previousPath === null || file.previousPath === file.path
        ? []
        : [decidePath(file.previousPath)]),
    ];
    return {
      path: file.path,
      previousPath: file.previousPath,
      sides,
      skipped: sides.every((side) => side.skipped),
    };
  };
};

const skippedFile = (file: DiffFile, decision: FileDecision): SkippedFile => ({
  path: file.path,
  previousPath: file.previousPath,
  additions: file.additions,
  deletions: file.deletions,
  reasons: decision.sides.flatMap((side) =>
    side.winner === null
      ? []
      : [{ path: side.path, pattern: side.winner.pattern, scope: side.winner.scope }],
  ),
});

/** Splits a snapshot into the files the agent reviews and the ones the rules skip. */
export const projectSnapshot = (
  rules: ReadonlyArray<EffectiveIgnoreRule>,
  snapshot: DiffSnapshot,
): { readonly reviewed: DiffSnapshot; readonly skipped: ReadonlyArray<SkippedFile> } => {
  const decide = ignoreMatcher(rules);
  const reviewed: Array<DiffFile> = [];
  const skipped: Array<SkippedFile> = [];
  for (const file of snapshot.files) {
    const decision = decide(file);
    if (decision.skipped) skipped.push(skippedFile(file, decision));
    else reviewed.push(file);
  }
  return { reviewed: { files: reviewed }, skipped };
};

/** The reviewed files of a stored snapshot, from the attempt's stored decisions. */
export const reviewedSnapshot = (
  snapshot: DiffSnapshot,
  skipped: ReadonlyArray<SkippedFile>,
): DiffSnapshot => {
  const left = new Set(skipped.map((file) => file.path));
  return { files: snapshot.files.filter((file) => !left.has(file.path)) };
};

export const describeRule = (rule: { readonly pattern: string; readonly scope: GuideScopeName }) =>
  `\`${rule.pattern}\` (${SCOPE_LABELS[rule.scope]})`;

/** Why generation can't start: every changed file is skipped, with every rule that decided one. */
export const everythingSkippedMessage = (
  skipped: ReadonlyArray<{
    readonly reasons: ReadonlyArray<{ readonly pattern: string; readonly scope: GuideScopeName }>;
  }>,
) => {
  const rules = [
    ...new Set(skipped.flatMap((file) => file.reasons.map((reason) => describeRule(reason)))),
  ];
  return `Your ignore rules skip every changed file, so there is nothing to write a guide about. Rules that decided: ${rules.join(", ")}. Change them in Settings > Guides or in the composer, then generate again.`;
};
