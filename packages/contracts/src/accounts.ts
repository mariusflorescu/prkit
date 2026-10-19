import * as Schema from "effect/Schema";

import { AccountId } from "./ids.ts";

export const AccountStatus = Schema.Union([
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("error", { message: Schema.String }),
]);

export const Account = Schema.Struct({
  id: AccountId,
  host: Schema.String,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  configDir: Schema.String,
  status: AccountStatus,
});
export type Account = typeof Account.Type;

/**
 * A gh config directory prkit couldn't read, when no account stands for it. A directory whose
 * accounts prkit knows from an earlier read shows its reason on those accounts instead.
 */
export const ConfigDirProblem = Schema.Struct({
  configDir: Schema.String,
  message: Schema.String,
});
export type ConfigDirProblem = typeof ConfigDirProblem.Type;

export const AccountsResult = Schema.Struct({
  accounts: Schema.Array(Account),
  addedConfigDirs: Schema.Array(Schema.String),
  configDirProblems: Schema.Array(ConfigDirProblem),
});
export type AccountsResult = typeof AccountsResult.Type;

export class AccountsError extends Schema.TaggedError<AccountsError>()("AccountsError", {
  message: Schema.String,
}) {}

export class ConfigDirNotFoundError extends Schema.TaggedError<ConfigDirNotFoundError>()(
  "ConfigDirNotFoundError",
  { path: Schema.String, message: Schema.String },
) {}
export class ConfigDirNoHostsError extends Schema.TaggedError<ConfigDirNoHostsError>()(
  "ConfigDirNoHostsError",
  { path: Schema.String, message: Schema.String },
) {}
export class ConfigDirAlreadyAddedError extends Schema.TaggedError<ConfigDirAlreadyAddedError>()(
  "ConfigDirAlreadyAddedError",
  { path: Schema.String, message: Schema.String },
) {}
export class ConfigDirNotAddedError extends Schema.TaggedError<ConfigDirNotAddedError>()(
  "ConfigDirNotAddedError",
  { path: Schema.String, message: Schema.String },
) {}
export class AccountUnavailableError extends Schema.TaggedError<AccountUnavailableError>()(
  "AccountUnavailableError",
  { accountId: AccountId, message: Schema.String },
) {}
