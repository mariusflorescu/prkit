import * as Schema from "effect/Schema";

import { AccountId, PullRequestKey } from "./ids.ts";

/** One ignore rule or focus area. Never reused, so an override can't attach to a new item. */
export const GuideItemId = Schema.NonEmptyString.pipe(Schema.brand("GuideItemId"));
export type GuideItemId = typeof GuideItemId.Type;

/** `${host}/${databaseId}`: survives renames and transfers, unlike owner/name. */
export const RepositoryId = Schema.NonEmptyString.pipe(Schema.brand("RepositoryId"));
export type RepositoryId = typeof RepositoryId.Type;
export const repositoryIdOf = (host: string, databaseId: number) =>
  RepositoryId.make(`${host}/${databaseId}`);

/** Least to most specific. */
export const GuideScopeName = Schema.Literals(["global", "repository", "pull-request"]);
export type GuideScopeName = typeof GuideScopeName.Type;

export const GuideScope = Schema.Union([
  Schema.TaggedStruct("global", {}),
  Schema.TaggedStruct("repository", { repositoryId: RepositoryId }),
  Schema.TaggedStruct("pull-request", { key: PullRequestKey }),
]);
export type GuideScope = typeof GuideScope.Type;

/** An explicit on or off for an inherited item. Inherit is the absence of one. */
export const GuideOverride = Schema.Struct({
  itemId: GuideItemId,
  value: Schema.Literals(["on", "off"]),
});
export type GuideOverride = typeof GuideOverride.Type;

export const IgnoreRule = Schema.Struct({ id: GuideItemId, pattern: Schema.String });
export type IgnoreRule = typeof IgnoreRule.Type;

/** `question` is what the reviewer wants answered, e.g. "Can these migrations run twice safely?" */
export const FocusArea = Schema.Struct({
  id: GuideItemId,
  label: Schema.String,
  question: Schema.String,
});
export type FocusArea = typeof FocusArea.Type;

/** `replace` drops the less specific scopes' guidance for the pull requests it covers. */
export const GuidanceMode = Schema.Literals(["append", "replace"]);
export type GuidanceMode = typeof GuidanceMode.Type;

/** Each section of a scope is saved on its own, compared and set on `version`. */
export const IgnoreSection = Schema.Struct({
  version: Schema.Int,
  rules: Schema.Array(IgnoreRule),
  overrides: Schema.Array(GuideOverride),
});
export type IgnoreSection = typeof IgnoreSection.Type;
export const FocusSection = Schema.Struct({
  version: Schema.Int,
  areas: Schema.Array(FocusArea),
  overrides: Schema.Array(GuideOverride),
});
export type FocusSection = typeof FocusSection.Type;
export const GuidanceSection = Schema.Struct({
  version: Schema.Int,
  text: Schema.String,
  mode: GuidanceMode,
});
export type GuidanceSection = typeof GuidanceSection.Type;

/** One scope's own settings. A scope nobody saved yet is all empty at version 0. */
export const ScopeConfig = Schema.Struct({
  ignore: IgnoreSection,
  focus: FocusSection,
  guidance: GuidanceSection,
});
export type ScopeConfig = typeof ScopeConfig.Type;

export const emptyScopeConfig: ScopeConfig = {
  ignore: { version: 0, rules: [], overrides: [] },
  focus: { version: 0, areas: [], overrides: [] },
  guidance: { version: 0, text: "", mode: "append" },
};

/** A repository prkit has seen, with the name it last had. */
export const GuideRepository = Schema.Struct({
  id: RepositoryId,
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
});
export type GuideRepository = typeof GuideRepository.Type;

/** The three scopes that shape one pull request's guide. */
export const PullRequestGuideConfig = Schema.Struct({
  repository: GuideRepository,
  global: ScopeConfig,
  repositoryConfig: ScopeConfig,
  pullRequest: ScopeConfig,
  /** The hash an attempt started now would record; differs from a revision's when settings changed. */
  hash: Schema.String,
});
export type PullRequestGuideConfig = typeof PullRequestGuideConfig.Type;

/** A new item has no id yet; the server gives it one. */
export const GuideSectionEdit = Schema.Union([
  Schema.TaggedStruct("ignore", {
    rules: Schema.Array(Schema.Struct({ id: Schema.NullOr(GuideItemId), pattern: Schema.String })),
    overrides: Schema.Array(GuideOverride),
  }),
  Schema.TaggedStruct("focus", {
    areas: Schema.Array(
      Schema.Struct({
        id: Schema.NullOr(GuideItemId),
        label: Schema.String,
        question: Schema.String,
      }),
    ),
    overrides: Schema.Array(GuideOverride),
  }),
  Schema.TaggedStruct("guidance", { text: Schema.String, mode: GuidanceMode }),
]);
export type GuideSectionEdit = typeof GuideSectionEdit.Type;

export const GuideConfigSave = Schema.Struct({
  scope: GuideScope,
  /** The version the form was loaded with; a newer one on the server refuses the save. */
  expectedVersion: Schema.Int,
  edit: GuideSectionEdit,
});
export type GuideConfigSave = typeof GuideConfigSave.Type;

/** The PR guidance typed in the composer, saved when the guide starts. */
export const GuidanceEdit = Schema.Struct({
  expectedVersion: Schema.Int,
  text: Schema.String,
  mode: GuidanceMode,
});
export type GuidanceEdit = typeof GuidanceEdit.Type;

export const FindRepositoryInput = Schema.Struct({
  accountId: AccountId,
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
});

/** An inherited or own item as it applies to one pull request. */
const effectiveFields = {
  scope: GuideScopeName,
  active: Schema.Boolean,
  /** The scope whose explicit on/off decided `active`; null when nothing overrides it. */
  decidedBy: Schema.NullOr(GuideScopeName),
};
export const EffectiveIgnoreRule = Schema.Struct({
  id: GuideItemId,
  pattern: Schema.String,
  ...effectiveFields,
});
export type EffectiveIgnoreRule = typeof EffectiveIgnoreRule.Type;
export const EffectiveFocusArea = Schema.Struct({
  id: GuideItemId,
  label: Schema.String,
  question: Schema.String,
  ...effectiveFields,
  /** The id the agent answers it under in `focusAreas`, unique per attempt; null when off. */
  handle: Schema.NullOr(Schema.String),
});
export type EffectiveFocusArea = typeof EffectiveFocusArea.Type;
export const EffectiveGuidance = Schema.Struct({
  scope: GuideScopeName,
  text: Schema.String,
  /** The more specific scope whose `replace` dropped this block; null when it applies. */
  replacedBy: Schema.NullOr(GuideScopeName),
});
export type EffectiveGuidance = typeof EffectiveGuidance.Type;
/** An override whose item was deleted. It does nothing and never attaches to a new item. */
export const DanglingOverride = Schema.Struct({
  scope: GuideScopeName,
  kind: Schema.Literals(["ignore", "focus"]),
  itemId: GuideItemId,
});
export type DanglingOverride = typeof DanglingOverride.Type;

export const ResolvedGuideConfig = Schema.Struct({
  /** Every rule in effective order: Global, Repository, then PR, each in list order. */
  ignore: Schema.Array(EffectiveIgnoreRule),
  focusAreas: Schema.Array(EffectiveFocusArea),
  guidance: Schema.Array(EffectiveGuidance),
  dangling: Schema.Array(DanglingOverride),
  hash: Schema.String,
});
export type ResolvedGuideConfig = typeof ResolvedGuideConfig.Type;

/** The rule that decided one path of a skipped file. */
export const SkipReason = Schema.Struct({
  path: Schema.String,
  pattern: Schema.String,
  scope: GuideScopeName,
});
export type SkipReason = typeof SkipReason.Type;

export const SkippedFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: Schema.Int,
  deletions: Schema.Int,
  /** One per path: the new path's, then the old path's for a rename. */
  reasons: Schema.Array(SkipReason),
});
export type SkippedFile = typeof SkippedFile.Type;

/**
 * What one attempt ran with, resolved once when it started and never changed:
 * snapshot filtering, the prompt, validation and acceptance all read this.
 */
export const AttemptConfig = Schema.Struct({
  ...ResolvedGuideConfig.fields,
  /** Null for attempts from before repository settings existed. */
  repository: Schema.NullOr(GuideRepository),
  skipped: Schema.Array(SkippedFile),
});
export type AttemptConfig = typeof AttemptConfig.Type;

export class GuideConfigError extends Schema.TaggedError<GuideConfigError>()("GuideConfigError", {
  message: Schema.String,
}) {}

/** The form was loaded before someone else saved this section. */
export class GuideConfigConflict extends Schema.TaggedError<GuideConfigConflict>()(
  "GuideConfigConflict",
  { message: Schema.String },
) {}
