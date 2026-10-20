import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  AgentAccent,
  AgentEnvironmentVariable,
  AgentInstanceId,
  AgentLogin,
  AgentProviderKind,
  defaultInstanceId,
} from "./agentInstance.ts";
import { ModelOptionDescriptor, ModelOptionSelection, resolveModelOptions } from "./model.ts";

/** Why a provider can't write guides right now, so the UI can say what to do about it. */
export const AgentUnavailableReason = Schema.Literals([
  "not-installed",
  "logged-out",
  /** The user's login lives in the keychain, where prkit's Codex home can't reach it: sign in for prkit. */
  "keychain-login",
  "not-subscription",
  "error",
  /** Turned off in Settings > Agents. */
  "off",
  /** prkit couldn't read the sensitive values saved for it, so it won't run without them. */
  "secrets",
]);
export type AgentUnavailableReason = typeof AgentUnavailableReason.Type;

/**
 * prkit signed this agent in itself, apart from the user's own login, because that one can't
 * be shared (Codex keeping its login in the keychain). Only this login can be signed out in prkit.
 */
const ownLogin = Schema.Boolean;

export const AgentProviderState = Schema.Union([
  /** `detail` names the login it runs on, such as "Claude Max subscription". */
  Schema.TaggedStruct("ready", { detail: Schema.String, ownLogin }),
  Schema.TaggedStruct("unavailable", {
    reason: AgentUnavailableReason,
    message: Schema.String,
    /** The one terminal command that fixes it, when there is one. */
    fix: Schema.NullOr(Schema.String),
    ownLogin,
  }),
]);
export type AgentProviderState = typeof AgentProviderState.Type;

/** The page that signs an agent in for prkit, to open in the browser. */
export const AgentSignInPage = Schema.Struct({ url: Schema.String });
export type AgentSignInPage = typeof AgentSignInPage.Type;

export class AgentSignInError extends Schema.TaggedError<AgentSignInError>()("AgentSignInError", {
  message: Schema.String,
}) {}

/** Installing Cursor's SDK on request: one step per package, then done. */
export const CursorSdkInstallProgress = Schema.Struct({
  /** The package being downloaded and checked now; null once everything is in place. */
  name: Schema.NullOr(Schema.String),
  done: Schema.Number,
  total: Schema.Number,
});
export type CursorSdkInstallProgress = typeof CursorSdkInstallProgress.Type;

export class CursorSdkInstallError extends Schema.TaggedError<CursorSdkInstallError>()(
  "CursorSdkInstallError",
  { message: Schema.String },
) {}

export const AgentModel = Schema.Struct({
  slug: Schema.NonEmptyString,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  options: Schema.Array(ModelOptionDescriptor),
  /** Why this model can't be used on this machine yet, with the fix. */
  blocked: Schema.NullOr(Schema.String),
});
export type AgentModel = typeof AgentModel.Type;

/** One agent instance: its settings, its login, and the models and settings it offers. */
export const AgentCatalogEntry = Schema.Struct({
  instance: AgentInstanceId,
  kind: AgentProviderKind,
  label: Schema.String,
  accent: Schema.NullOr(AgentAccent),
  enabled: Schema.Boolean,
  isDefault: Schema.Boolean,
  configDir: Schema.NullOr(Schema.String),
  binaryPath: Schema.NullOr(Schema.String),
  /** Sensitive values come back empty, with `valueRedacted`. */
  environment: Schema.Array(AgentEnvironmentVariable),
  login: AgentLogin,
  /**
   * Instances in the same group share their conversations: the same kind and the same folder
   * the agent keeps its sessions in. Switching to another group starts a new conversation.
   */
  group: Schema.String,
  version: Schema.NullOr(Schema.String),
  state: AgentProviderState,
  models: Schema.Array(AgentModel),
});
export type AgentCatalogEntry = typeof AgentCatalogEntry.Type;

/**
 * An agent setting prkit can't read. It runs nothing, and nothing set to run on it runs on another
 * agent or login instead, until it is removed (or, for a default, reset).
 */
export const DamagedAgent = Schema.Struct({
  instance: AgentInstanceId,
  /** Null when the kind can't be read either. */
  kind: Schema.NullOr(AgentProviderKind),
  isDefault: Schema.Boolean,
  /** What happened and the way out, in words for the user. */
  message: Schema.String,
});
export type DamagedAgent = typeof DamagedAgent.Type;

/**
 * Every instance, default first within each kind, its login, and the models it offers, and the
 * settings prkit can't read.
 */
export const AgentCatalog = Schema.Struct({
  providers: Schema.Array(AgentCatalogEntry),
  damaged: Schema.Array(DamagedAgent),
});
export type AgentCatalog = typeof AgentCatalog.Type;

const SelectionFields = {
  model: Schema.NonEmptyString,
  options: Schema.Array(ModelOptionSelection),
};
const CurrentSelection = Schema.Struct({ instance: AgentInstanceId, ...SelectionFields });
/** Saved before agent instances: the kind stood for its only instance, now its default one. */
const KindSelection = Schema.Struct({ provider: AgentProviderKind, ...SelectionFields }).pipe(
  Schema.decodeTo(CurrentSelection, {
    decode: SchemaGetter.transform((old) => ({
      instance: old.provider,
      model: old.model,
      options: old.options,
    })),
    encode: SchemaGetter.forbidden(() => "Selections are saved by instance."),
  }),
);

/** Who writes a guide: the agent instance, the model and the model's settings. */
export const AgentSelection = Schema.Union([CurrentSelection, KindSelection]);
export type AgentSelection = typeof AgentSelection.Type;

export const findAgentEntry = (catalog: AgentCatalog, instance: string) =>
  catalog.providers.find((entry) => entry.instance === instance);

export const findAgentModel = (catalog: AgentCatalog, instance: string, slug: string | null) =>
  findAgentEntry(catalog, instance)?.models.find((model) => model.slug === slug);

export const findDamagedAgent = (catalog: AgentCatalog, instance: string) =>
  catalog.damaged.find((entry) => entry.instance === instance);

/**
 * The setting prkit can't read that a guide or fix session on `instance` stays on: its own, or its
 * kind's default when its own is off or gone. Such a session runs nowhere else until it is fixed
 * or another agent is picked.
 */
export const pinnedDamage = (catalog: AgentCatalog, instance: string, kind: AgentProviderKind) =>
  findDamagedAgent(catalog, instance) ??
  (findAgentEntry(catalog, instance)?.enabled === true
    ? undefined
    : findDamagedAgent(catalog, defaultInstanceId(kind)));

/** Why a selection can't run now, in words for the user, or null when it can. */
export const selectionProblem = (catalog: AgentCatalog, selection: AgentSelection) => {
  const damaged = findDamagedAgent(catalog, selection.instance);
  if (damaged !== undefined) return damaged.message;
  const provider = findAgentEntry(catalog, selection.instance);
  if (provider === undefined)
    return "That agent was removed in Settings > Agents. Pick another one.";
  if (provider.state._tag === "unavailable") return provider.state.message;
  const model = provider.models.find((entry) => entry.slug === selection.model);
  if (model === undefined)
    return `${provider.label} doesn't offer ${selection.model} on this login. Pick another model.`;
  if (model.blocked !== null) return model.blocked;
  const resolved = resolveModelOptions(model.options, selection.options);
  for (const choice of selection.options) {
    const option = resolved.find((entry) => entry.descriptor.id === choice.id);
    if (option !== undefined && option.value !== choice.value)
      return `${model.name} can't use ${option.descriptor.label} ${String(choice.value)}.`;
  }
  return null;
};

/**
 * The selection to use when none is given: `preferred` if it can run, else the
 * default model of the first ready instance. Null when no agent is ready. A `preferred` whose
 * setting prkit can't read stays, so it says why rather than running on another login.
 */
export const effectiveSelection = (
  catalog: AgentCatalog,
  preferred: AgentSelection | null,
): AgentSelection | null => {
  if (
    preferred !== null &&
    (findDamagedAgent(catalog, preferred.instance) !== undefined ||
      selectionProblem(catalog, preferred) === null)
  )
    return preferred;
  for (const provider of catalog.providers) {
    if (provider.state._tag !== "ready") continue;
    const usable = provider.models.filter((model) => model.blocked === null);
    const model = usable.find((entry) => entry.isDefault) ?? usable[0];
    if (model !== undefined) return { instance: provider.instance, model: model.slug, options: [] };
  }
  return null;
};

/**
 * What a PR's guide or fix session runs on next, as the server picks it: its own instance while
 * that is on, else its kind's default instance while that is on, else `fallback` (the default
 * agent). Each is then checked as `effectiveSelection` checks it. An own instance, or a kind's
 * default, whose setting prkit can't read stays, so it says why rather than running on another
 * login.
 */
export const sessionSelection = (
  catalog: AgentCatalog,
  own:
    | (AgentSelection & {
        readonly kind: AgentProviderKind;
      })
    | null,
  fallback: AgentSelection | null,
) => {
  if (own === null) return effectiveSelection(catalog, fallback);
  const selection = { model: own.model, options: own.options };
  const pinned = pinnedDamage(catalog, own.instance, own.kind);
  if (pinned !== undefined) return { ...selection, instance: pinned.instance };
  if (findAgentEntry(catalog, own.instance)?.enabled === true)
    return effectiveSelection(catalog, { ...selection, instance: own.instance });
  const kindDefault = defaultInstanceId(own.kind);
  if (findAgentEntry(catalog, kindDefault)?.enabled === true)
    return effectiveSelection(catalog, { ...selection, instance: kindDefault });
  return effectiveSelection(catalog, fallback);
};

/**
 * Whether moving a PR's guide or fix session from one instance to another keeps its
 * conversation: only within one group. An instance that is gone keeps nothing but itself.
 */
export const keepsConversation = (catalog: AgentCatalog, from: string, to: string) => {
  if (from === to) return true;
  const before = findAgentEntry(catalog, from);
  const after = findAgentEntry(catalog, to);
  return before !== undefined && after !== undefined && before.group === after.group;
};
