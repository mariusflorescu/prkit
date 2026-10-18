import {
  type AccountId,
  emptyScopeConfig,
  FocusArea,
  GuidanceMode,
  GuideConfigConflict,
  GuideConfigError,
  type GuideConfigSave,
  GuideItemId,
  GuideOverride,
  type GuideRepository,
  type GuideScope,
  type GuideSectionEdit,
  IgnoreRule,
  ignorePatternProblem,
  type PullRequestGuideConfig,
  type PullRequestKey,
  RepositoryId,
  repositoryIdOf,
  refFromKey,
  resolveGuideConfig,
  type ScopeConfig,
} from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { GitHubApi } from "../github/GitHubApi.ts";

const PathRulesValue = Schema.Struct({
  rules: Schema.Array(IgnoreRule),
  overrides: Schema.Array(GuideOverride),
});
const FocusValue = Schema.Struct({
  areas: Schema.Array(FocusArea),
  overrides: Schema.Array(GuideOverride),
});
const GuidanceValue = Schema.Struct({ text: Schema.String, mode: GuidanceMode });
const PathRulesJson = Schema.fromJsonString(PathRulesValue);
const FocusJson = Schema.fromJsonString(FocusValue);
const GuidanceJson = Schema.fromJsonString(GuidanceValue);

const SectionRow = Schema.Struct({
  scope: Schema.String,
  section: Schema.Literals(["ignore", "sensitive", "focus", "guidance"]),
  version: Schema.Int,
  value: Schema.String,
});
const RepositoryRow = Schema.Struct({
  id: RepositoryId,
  host: Schema.String,
  owner: Schema.String,
  name: Schema.String,
});
const decodeSections = Schema.decodeUnknownEffect(Schema.Array(SectionRow));
const decodePathRules = Schema.decodeEffect(PathRulesJson);
const decodeFocus = Schema.decodeEffect(FocusJson);
const decodeGuidance = Schema.decodeEffect(GuidanceJson);
const decodeRepositories = Schema.decodeUnknownEffect(Schema.Array(RepositoryRow));
const RepositoryResponse = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});

const MAX_RULES = 200;
const MAX_AREAS = 30;
const MAX_LABEL = 60;
const MAX_QUESTION = 300;
const MAX_GUIDANCE = 4000;
/** Repository ids barely change; a lookup per repository per ten minutes is plenty. */
const REPOSITORY_TTL_MS = 10 * 60_000;

const scopeKey = (scope: GuideScope) => {
  switch (scope._tag) {
    case "global":
      return "global";
    case "repository":
      return `repository:${scope.repositoryId}`;
    case "pull-request":
      return `pull-request:${scope.key}`;
  }
};

/** What's wrong with an edit, in words for the reviewer, or null. Trims before checking. */
const editProblem = (scope: GuideScope, edit: GuideSectionEdit): string | null => {
  const inherits = scope._tag !== "global";
  switch (edit._tag) {
    case "ignore":
    case "sensitive": {
      if (edit.rules.length > MAX_RULES)
        return `Keep it to ${MAX_RULES} ${edit._tag === "ignore" ? "rules" : "paths"}.`;
      const seen = new Set<string>();
      for (const rule of edit.rules) {
        const problem = ignorePatternProblem(rule.pattern);
        if (problem !== null) return `\`${rule.pattern}\`: ${problem}`;
        if (seen.has(rule.pattern)) return `\`${rule.pattern}\` is in the list twice.`;
        seen.add(rule.pattern);
      }
      break;
    }
    case "focus": {
      if (edit.areas.length > MAX_AREAS) return `Keep it to ${MAX_AREAS} focus areas.`;
      const seen = new Set<string>();
      for (const area of edit.areas) {
        if (area.label === "") return "Every focus area needs a label.";
        if (area.label.length > MAX_LABEL)
          return `"${area.label}" is a long label. Keep it under ${MAX_LABEL} characters.`;
        if (area.question === "")
          return `"${area.label}" needs a question: what should the guide answer?`;
        if (area.question.length > MAX_QUESTION)
          return `"${area.label}": keep the question under ${MAX_QUESTION} characters.`;
        const key = area.label.toLowerCase();
        if (seen.has(key)) return `Two focus areas are called "${area.label}".`;
        seen.add(key);
      }
      break;
    }
    case "guidance":
      if (edit.text.length > MAX_GUIDANCE)
        return `Keep the guidance under ${MAX_GUIDANCE} characters.`;
      if (!inherits && edit.mode === "replace")
        return "Global guidance has nothing to replace, so it always appends.";
      break;
  }
  if (edit._tag !== "guidance") {
    if (!inherits && edit.overrides.length > 0)
      return "Global settings have nothing to inherit, so they can't switch items on or off.";
    if (new Set(edit.overrides.map((override) => override.itemId)).size < edit.overrides.length)
      return "An inherited item is switched on or off twice.";
  }
  return null;
};

const trimmed = (edit: GuideSectionEdit): GuideSectionEdit => {
  switch (edit._tag) {
    case "ignore":
    case "sensitive":
      return {
        ...edit,
        rules: edit.rules.map((rule) => ({ ...rule, pattern: rule.pattern.trim() })),
      };
    case "focus":
      return {
        ...edit,
        areas: edit.areas.map((area) => ({
          ...area,
          label: area.label.trim(),
          question: area.question.trim(),
        })),
      };
    case "guidance":
      return { ...edit, text: edit.text.trim() };
  }
};

const CONFLICT =
  "These settings changed since you opened them, maybe in another window. Reload them to see the latest, then make your change again.";

/**
 * Guide settings (docs/internals/architecture.md "Guide settings"): each scope's ignore
 * rules, look-closely paths, focus areas and guidance, saved per section with a version check.
 */
export class GuideConfigStore extends Context.Service<
  GuideConfigStore,
  Effect.Success<typeof make>
>()("@prkit/server/reviews/GuideConfigStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const api = yield* GitHubApi;
  const lookups = new Map<
    string,
    { readonly repository: GuideRepository; readonly expiresAt: number }
  >();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // The OS random source failing is not something a save can recover from.
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(GuideItemId.make));
  const failure = (message: string) => () => Effect.fail(new GuideConfigError({ message }));

  /** The section's new stored value. A new item gets an id; a known id must still exist. */
  const encodeEdit = (edit: GuideSectionEdit, current: ScopeConfig) =>
    Effect.gen(function* () {
      switch (edit._tag) {
        case "ignore":
        case "sensitive": {
          const known = new Set(current[edit._tag].rules.map((rule) => rule.id));
          const rules: Array<IgnoreRule> = [];
          for (const rule of edit.rules) {
            if (rule.id !== null && !known.has(rule.id))
              return yield* new GuideConfigConflict({ message: CONFLICT });
            rules.push({ id: rule.id ?? (yield* newId), pattern: rule.pattern });
          }
          return yield* Schema.encodeEffect(PathRulesJson)({ rules, overrides: edit.overrides });
        }
        case "focus": {
          const known = new Set(current.focus.areas.map((area) => area.id));
          const areas: Array<FocusArea> = [];
          for (const area of edit.areas) {
            if (area.id !== null && !known.has(area.id))
              return yield* new GuideConfigConflict({ message: CONFLICT });
            areas.push({
              id: area.id ?? (yield* newId),
              label: area.label,
              question: area.question,
            });
          }
          return yield* Schema.encodeEffect(FocusJson)({ areas, overrides: edit.overrides });
        }
        case "guidance":
          return yield* Schema.encodeEffect(GuidanceJson)({ text: edit.text, mode: edit.mode });
      }
    });
  const readFailures = {
    SqlError: failure("prkit couldn't read your guide settings. Try again."),
    SchemaError: failure("prkit read damaged guide settings. Save them again."),
  };

  /** Every scope's sections in one read, so an attempt sees one consistent state. */
  const read = (scopes: ReadonlyArray<GuideScope>) =>
    Effect.gen(function* () {
      const keys = scopes.map(scopeKey);
      const rows = yield* sql`
        SELECT scope, section, version, value FROM guide_config WHERE scope IN ${sql.in(keys)}`.pipe(
        Effect.flatMap(decodeSections),
      );
      const row = (key: string, section: (typeof SectionRow.Type)["section"]) =>
        rows.find((entry) => entry.scope === key && entry.section === section);
      const configs = new Map<string, ScopeConfig>();
      for (const key of keys) {
        const ignore = row(key, "ignore");
        const sensitive = row(key, "sensitive");
        const focus = row(key, "focus");
        const guidance = row(key, "guidance");
        configs.set(key, {
          ignore:
            ignore === undefined
              ? emptyScopeConfig.ignore
              : { version: ignore.version, ...(yield* decodePathRules(ignore.value)) },
          sensitive:
            sensitive === undefined
              ? emptyScopeConfig.sensitive
              : { version: sensitive.version, ...(yield* decodePathRules(sensitive.value)) },
          focus:
            focus === undefined
              ? emptyScopeConfig.focus
              : { version: focus.version, ...(yield* decodeFocus(focus.value)) },
          guidance:
            guidance === undefined
              ? emptyScopeConfig.guidance
              : { version: guidance.version, ...(yield* decodeGuidance(guidance.value)) },
        });
      }
      return (scope: GuideScope) => configs.get(scopeKey(scope)) ?? emptyScopeConfig;
    });

  const scope = (ref: GuideScope) =>
    read([ref]).pipe(
      Effect.map((get) => get(ref)),
      Effect.catchTags(readFailures),
    );

  const layers = (repositoryId: RepositoryId | null, key: PullRequestKey) =>
    Effect.gen(function* () {
      const global: GuideScope = { _tag: "global" };
      const pullRequest: GuideScope = { _tag: "pull-request", key };
      const repository: GuideScope | null =
        repositoryId === null ? null : { _tag: "repository", repositoryId };
      const get = yield* read(
        repository === null ? [global, pullRequest] : [global, repository, pullRequest],
      );
      return {
        global: get(global),
        repository: repository === null ? null : get(repository),
        pullRequest: get(pullRequest),
      };
    });

  /** The resolved settings for one PR, read atomically; an attempt freezes this. */
  const resolve = (repositoryId: RepositoryId, key: PullRequestKey) =>
    layers(repositoryId, key).pipe(Effect.map(resolveGuideConfig));

  const save = (input: GuideConfigSave) =>
    Effect.gen(function* () {
      const edit = trimmed(input.edit);
      const problem = editProblem(input.scope, edit);
      if (problem !== null) return yield* new GuideConfigError({ message: problem });
      const current = (yield* read([input.scope]))(input.scope);
      if (current[edit._tag].version !== input.expectedVersion)
        return yield* new GuideConfigConflict({ message: CONFLICT });
      const value = yield* encodeEdit(edit, current);
      const key = scopeKey(input.scope);
      const at = yield* now;
      const written =
        input.expectedVersion === 0
          ? yield* sql`
              INSERT INTO guide_config (scope, section, version, value, updated_at)
              VALUES (${key}, ${edit._tag}, 1, ${value}, ${at})
              ON CONFLICT (scope, section) DO NOTHING RETURNING version`
          : yield* sql`
              UPDATE guide_config SET version = version + 1, value = ${value}, updated_at = ${at}
              WHERE scope = ${key} AND section = ${edit._tag} AND version = ${input.expectedVersion}
              RETURNING version`;
      if (written.length === 0) return yield* new GuideConfigConflict({ message: CONFLICT });
      yield* Effect.logInfo("Saved guide settings").pipe(
        Effect.annotateLogs({ scope: key, section: edit._tag, version: input.expectedVersion + 1 }),
      );
      return (yield* read([input.scope]))(input.scope);
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't save your guide settings. Try again."),
        SchemaError: failure("prkit couldn't save those guide settings. Try again."),
      }),
    );

  /** Records the name a repository has now, for Settings to show. */
  const remember = (repository: GuideRepository) =>
    Effect.gen(function* () {
      const at = yield* now;
      yield* sql`
        INSERT INTO guide_repositories (id, host, owner, name, seen_at)
        VALUES (${repository.id}, ${repository.host}, ${repository.owner}, ${repository.name}, ${at})
        ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, name = excluded.name, seen_at = excluded.seen_at`;
    });

  /** Repositories with settings of their own, by their last known name. */
  const repositories = () =>
    sql`
      SELECT DISTINCT r.id, r.host, r.owner, r.name FROM guide_repositories r
      JOIN guide_config c ON c.scope = 'repository:' || r.id
      ORDER BY r.owner, r.name`.pipe(
      Effect.flatMap(decodeRepositories),
      Effect.catchTags(readFailures),
    );

  /** GitHub's id for a repository, read through the account that found it. */
  const findRepository = (input: {
    readonly accountId: AccountId;
    readonly host: string;
    readonly owner: string;
    readonly name: string;
  }) =>
    Effect.gen(function* () {
      const cacheKey = `${input.accountId}|${input.host}/${input.owner}/${input.name}`;
      const now = yield* Clock.currentTimeMillis;
      const cached = lookups.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now) return cached.repository;
      const response = yield* api.rest(
        input.accountId,
        `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}`,
        RepositoryResponse,
      );
      const repository: GuideRepository = {
        id: repositoryIdOf(input.host, response.id),
        host: input.host,
        owner: response.owner.login,
        name: response.name,
      };
      lookups.set(cacheKey, { repository, expiresAt: now + REPOSITORY_TTL_MS });
      yield* remember(repository);
      return repository;
    }).pipe(
      Effect.catchTags({
        GitHubRequestError: (error) =>
          Effect.fail(
            new GuideConfigError({
              message: `prkit couldn't look up ${input.owner}/${input.name} through ${input.accountId}. ${error.message}`,
            }),
          ),
        SqlError: readFailures.SqlError,
      }),
    );

  /** The composer's view: the three scopes for one PR and the hash an attempt would freeze now. */
  const forPullRequest = (key: PullRequestKey, accountId: AccountId) =>
    Effect.gen(function* () {
      const ref = refFromKey(key);
      if (ref === null)
        return yield* new GuideConfigError({ message: "That doesn't look like a pull request." });
      const repository = yield* findRepository({
        accountId,
        host: ref.host,
        owner: ref.owner,
        name: ref.repo,
      });
      const resolved = yield* layers(repository.id, key).pipe(Effect.catchTags(readFailures));
      return {
        repository,
        global: resolved.global,
        repositoryConfig: resolved.repository ?? emptyScopeConfig,
        pullRequest: resolved.pullRequest,
        hash: resolveGuideConfig(resolved).hash,
      } satisfies PullRequestGuideConfig;
    });

  return { scope, layers, resolve, save, remember, repositories, findRepository, forPullRequest };
});

export const layer = Layer.effect(GuideConfigStore, make);
