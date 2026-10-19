import {
  Account,
  AccountId,
  AccountsError,
  AccountsResult,
  AccountUnavailableError,
  childEnv,
  ConfigDirAlreadyAddedError,
  type ConfigDirProblem,
  ConfigDirNoHostsError,
  ConfigDirNotAddedError,
  ConfigDirNotFoundError,
} from "@prkit/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import { parse } from "yaml";

import { resolveGh } from "./resolveGh.ts";

/**
 * gh writes a user whose token is in the keyring with no value, and `{}` when no one is logged
 * in. It empties the file before writing it, so an empty file may be one it is still writing.
 */
const Hosts = Schema.Record(
  Schema.String,
  Schema.Struct({
    user: Schema.optionalKey(Schema.String),
    users: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.Null, Schema.Literal(""), Schema.Struct({})]),
      ),
    ),
  }),
);
const AddedDirs = Schema.Array(Schema.Struct({ path: Schema.String }));
const RememberedRows = Schema.Array(
  Schema.Struct({ config_dir: Schema.String, host: Schema.String, login: Schema.String }),
);

type Login = { readonly host: string; readonly login: string };
type Failure = "unopenable" | "unreadable" | "damaged";
type Listing =
  | {
      readonly _tag: "listed";
      readonly configDir: string;
      readonly logins: ReadonlyArray<Login & { readonly active: boolean }>;
    }
  | {
      readonly _tag: "failed";
      readonly configDir: string;
      readonly failure: Failure;
      readonly remembered: ReadonlyArray<Login>;
    };
const Profile = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.String,
});

const defaultApiBase = (host: string) =>
  host === "github.com" ? "https://api.github.com" : `https://api.${host}`;

/**
 * Verification only: `PRKIT_GITHUB_API_URL` sends every API call to a local fake
 * GitHub. Only plain loopback addresses are accepted, so a token never leaves the machine.
 */
const isLoopback = (url: URL) =>
  url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");

export class GitHubAccounts extends Context.Service<GitHubAccounts, Effect.Success<typeof make>>()(
  "@prkit/server/accounts/GitHubAccounts",
) {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const home = yield* Config.String("HOME").pipe(
    Effect.mapError(
      () =>
        new AccountsError({
          message: "The home directory is unavailable. Restart prkit from your login session.",
        }),
    ),
  );
  /**
   * gh treats an empty variable as unset. A relative one names a folder under whatever folder
   * gh runs in, which prkit can't know, so prkit leaves it out.
   */
  const variable = (name: string) =>
    Config.option(Config.String(name)).pipe(
      Effect.map(Option.filter((value) => path.isAbsolute(value))),
    );
  const configuredDir = yield* variable("GH_CONFIG_DIR");
  const xdgConfigHome = yield* variable("XDG_CONFIG_HOME");
  const apiOverride = yield* Config.option(Config.String("PRKIT_GITHUB_API_URL"));
  if (Option.isSome(apiOverride) && !URL.canParse(apiOverride.value))
    return yield* new AccountsError({ message: "PRKIT_GITHUB_API_URL must be a URL." });
  if (Option.isSome(apiOverride) && !isLoopback(new URL(apiOverride.value)))
    return yield* new AccountsError({
      message: "PRKIT_GITHUB_API_URL must be an http address on 127.0.0.1 or localhost.",
    });
  const apiBase = (host: string) =>
    Option.match(apiOverride, {
      onNone: () => defaultApiBase(host),
      onSome: (url) => url.replace(/\/$/, ""),
    });
  if (Option.isSome(apiOverride))
    yield* Effect.logWarning("Reading GitHub through a local fake").pipe(
      Effect.annotateLogs({ url: apiOverride.value }),
    );
  const gh = yield* resolveGh.pipe(
    Effect.map((path) => ({ _tag: "ready" as const, path })),
    Effect.catchTag("AccountsError", (error) =>
      Effect.succeed({ _tag: "error" as const, message: error.message }),
    ),
  );
  if (gh._tag === "ready")
    yield* Effect.logInfo("Resolved GitHub CLI").pipe(Effect.annotateLogs({ path: gh.path }));
  else yield* Effect.logWarning(gh.message);
  const gate = yield* Semaphore.make(1);
  const tokens = new Map<AccountId, Redacted.Redacted<string>>();
  let activeAccounts = new Set<AccountId>();
  let unreadableDirAccounts = new Set<AccountId>();
  let current: AccountsResult | null = null;
  const firstFound = yield* Deferred.make<
    {
      readonly accounts: ReadonlyArray<Pick<Account, "id" | "configDir" | "status">>;
      readonly configDirProblems: ReadonlyArray<ConfigDirProblem>;
    },
    AccountsError
  >();

  const normalize = (value: string) =>
    path.resolve(
      value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value,
    );
  const readAdded = () =>
    sql`SELECT path FROM github_config_dirs ORDER BY path`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AddedDirs)),
      Effect.mapError(
        () => new AccountsError({ message: "Couldn't read saved GitHub directories." }),
      ),
    );

  const homeRelative = (dir: string) =>
    dir === home ? "~" : dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
  const failureText = (failure: Failure, configDir: string, login: string | null) => {
    const hidden = login === null ? "find the accounts there" : `check ${login}`;
    switch (failure) {
      case "unopenable":
        return `prkit can't open ${homeRelative(configDir)}, so it can't ${hidden}. Check the directory's permissions, then retry.`;
      case "unreadable":
        return `prkit can't read ${homeRelative(path.join(configDir, "hosts.yml"))}, so it can't ${hidden}. Check the file's permissions, then retry.`;
      case "damaged":
        return `${homeRelative(path.join(configDir, "hosts.yml"))} is incomplete or isn't valid YAML, so prkit can't ${hidden}. If gh was saving it, retry. Otherwise run gh auth status with GH_CONFIG_DIR set to this directory.`;
    }
  };

  /**
   * Where gh looks, in its own order: `GH_CONFIG_DIR`, then `gh` in `XDG_CONFIG_HOME`, then in
   * ~/.config. When a config home can't be listed, its remembered `gh-*` directories are still
   * tried.
   */
  const candidates = (added: ReadonlyArray<string>, remembered: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const configHomes = [
        ...new Set([...Option.toArray(xdgConfigHome), path.join(home, ".config")].map(normalize)),
      ];
      const listed = yield* Effect.forEach(configHomes, (configHome) =>
        fs.readDirectory(configHome).pipe(
          Effect.map((names) => ({ configHome, names, problem: null })),
          Effect.catchTag("PlatformError", (error) =>
            Effect.succeed(
              error.reason._tag === "NotFound"
                ? { configHome, names: [], problem: null }
                : {
                    configHome,
                    names: remembered
                      .filter((dir) => path.dirname(dir) === configHome)
                      .map((dir) => path.basename(dir)),
                    problem: {
                      configDir: configHome,
                      message: `prkit can't list ${homeRelative(configHome)}, so it may miss gh directories there. Check the directory's permissions, then retry.`,
                    },
                  },
            ),
          ),
        ),
      );
      const dirs = [
        ...Option.toArray(configuredDir),
        ...listed.flatMap(({ configHome, names }) => [
          path.join(configHome, "gh"),
          ...names
            .filter((name) => name.startsWith("gh-"))
            .sort()
            .map((name) => path.join(configHome, name)),
        ]),
        ...added,
      ];
      return {
        dirs: [...new Set(dirs.map(normalize))],
        problems: listed.flatMap(({ problem }) => (problem === null ? [] : [problem])),
      };
    });

  const unavailable = (account: Account, message: string) =>
    new AccountUnavailableError({ accountId: account.id, message });
  const fromGh = (account: Account, active: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (gh._tag === "error") return yield* unavailable(account, gh.message);
        const command = ChildProcess.make(
          gh.path,
          [
            "auth",
            "token",
            "--hostname",
            account.host,
            ...(active ? [] : ["--user", account.login]),
          ],
          {
            env: childEnv(process.env, {
              GH_CONFIG_DIR: account.configDir,
              GH_PROMPT_DISABLED: "1",
            }),
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
          },
        );
        const child = yield* spawner.spawn(command);
        const output = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, part) => text + part,
          ),
        );
        const code = yield* child.exitCode;
        if (code !== 0 || output.trim() === "")
          return yield* unavailable(
            account,
            `No token is available for ${account.login}. Run gh auth login --hostname ${account.host} with GH_CONFIG_DIR set to this directory, then refresh.`,
          );
        return Redacted.make(output.trim());
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchTags({
          PlatformError: () =>
            Effect.fail(
              unavailable(
                account,
                "Couldn't run gh. Install GitHub CLI and make sure it is on your PATH.",
              ),
            ),
          TimeoutError: () =>
            Effect.fail(
              unavailable(
                account,
                "GitHub CLI took too long to read this account. Try refreshing.",
              ),
            ),
        }),
      ),
    );

  const verify = (account: Account, token: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("GitHub request").pipe(
        Effect.annotateLogs({ accountId: account.id, method: "GET", path: "/user" }),
      );
      const response = yield* http.execute(
        HttpClientRequest.get(`${apiBase(account.host)}/user`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeaders({
            "user-agent": "prkit",
            accept: "application/vnd.github+json",
          }),
        ),
      );
      if (response.status !== 200) {
        yield* response.text;
        return yield* unavailable(
          account,
          response.status === 401
            ? `gh has an expired token for ${account.login} in ${account.configDir}. Run gh auth refresh with GH_CONFIG_DIR set to this directory, then refresh.`
            : `GitHub couldn't verify ${account.login} (HTTP ${response.status}). Check the account with gh auth status, then refresh.`,
        );
      }
      const profile = yield* HttpClientResponse.schemaBodyJson(Profile)(response);
      if (profile.login.toLowerCase() !== account.login.toLowerCase())
        return yield* unavailable(
          account,
          `The token belongs to ${profile.login}, not ${account.login}. Fix this directory's gh login, then refresh.`,
        );
      return profile;
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            unavailable(
              account,
              "Couldn't reach GitHub to verify this account. Check your connection and refresh.",
            ),
          ),
        SchemaError: () =>
          Effect.fail(
            unavailable(account, "GitHub returned an unreadable account profile. Try refreshing."),
          ),
        TimeoutError: () =>
          Effect.logWarning("GitHub account verification reached its deadline").pipe(
            Effect.annotateLogs({ accountId: account.id, timeoutMs: 10_000 }),
            Effect.andThen(
              Effect.fail(
                unavailable(
                  account,
                  "GitHub took too long to verify this account. Try refreshing.",
                ),
              ),
            ),
          ),
      }),
    );

  /** What one gh config directory lists now, or why it can't be read. Null without a hosts.yml. */
  const look = (configDir: string, remembered: ReadonlyArray<Login>) =>
    Effect.gen(function* () {
      const failed = (failure: Failure) =>
        Effect.logWarning("Couldn't read GitHub config directory").pipe(
          Effect.annotateLogs({ configDir, failure }),
          Effect.as<Listing>({ _tag: "failed", configDir, failure, remembered }),
        );
      const hostsFile = path.join(configDir, "hosts.yml");
      const exists = yield* fs.exists(hostsFile).pipe(Effect.option);
      if (Option.isNone(exists)) return yield* failed("unopenable");
      if (!exists.value) return null;
      const text = yield* fs.readFileString(hostsFile).pipe(Effect.option);
      if (Option.isNone(text)) return yield* failed("unreadable");
      const hosts = yield* Effect.try({
        try: () => parse(text.value, { logLevel: "silent", prettyErrors: false }),
        catch: () => new AccountsError({ message: "hosts.yml isn't valid YAML." }),
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Hosts)), Effect.option);
      if (Option.isNone(hosts)) return yield* failed("damaged");
      const listing: Listing = {
        _tag: "listed",
        configDir,
        logins: Object.entries(hosts.value).flatMap(([host, settings]) =>
          [
            ...new Set([
              ...Object.keys(settings.users ?? {}),
              ...(settings.user ? [settings.user] : []),
            ]),
          ].map((login) => ({
            host,
            login,
            active: settings.user?.toLowerCase() === login.toLowerCase(),
          })),
        ),
      };
      return listing;
    });

  const readRemembered = () =>
    sql`SELECT config_dir, host, login FROM github_config_dir_accounts`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RememberedRows)),
      Effect.map((rows) => {
        const byDir = new Map<string, Array<Login>>();
        for (const row of rows)
          byDir.set(row.config_dir, [
            ...(byDir.get(row.config_dir) ?? []),
            { host: row.host, login: row.login },
          ]);
        return byDir;
      }),
      Effect.mapError(
        () => new AccountsError({ message: "Couldn't read saved GitHub directories." }),
      ),
    );
  /** A directory that can't be read keeps what it listed; one no longer found is forgotten. */
  const remember = (listings: ReadonlyArray<Listing>) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const failed = listings.flatMap((listing) =>
            listing._tag === "failed" ? [listing.configDir] : [],
          );
          yield* failed.length === 0
            ? sql`DELETE FROM github_config_dir_accounts`
            : sql`DELETE FROM github_config_dir_accounts WHERE config_dir NOT IN ${sql.in(failed)}`;
          for (const listing of listings)
            if (listing._tag === "listed")
              for (const { host, login } of listing.logins)
                yield* sql`INSERT INTO github_config_dir_accounts (config_dir, host, login)
                  VALUES (${listing.configDir}, ${host}, ${login})`;
        }),
      )
      .pipe(
        Effect.mapError(
          () => new AccountsError({ message: "Couldn't save your GitHub directories." }),
        ),
      );

  /**
   * The accounts the gh config directories list now, before GitHub verifies any of them. A
   * directory that can't be read holds the logins it listed before in its place, so no later
   * directory's token reads them.
   */
  const find = () =>
    Effect.gen(function* () {
      const addedConfigDirs = (yield* readAdded()).map((row) => row.path);
      const remembered = yield* readRemembered();
      const { dirs, problems } = yield* candidates(addedConfigDirs, [...remembered.keys()]);
      const listings = (yield* Effect.forEach(dirs, (configDir) =>
        look(configDir, remembered.get(configDir) ?? []),
      )).filter((listing) => listing !== null);
      yield* remember(listings);
      /** By login in lower case: GitHub logins ignore case, so `Octocat` and `octocat` are one account. */
      const found = new Map<string, Account>();
      const foundActiveAccounts = new Set<AccountId>();
      const unreadAccounts = new Set<AccountId>();
      const configDirProblems: Array<ConfigDirProblem> = [...problems];
      const claim = (configDir: string, { host, login }: Login, status: Account["status"]) => {
        const id = AccountId.make(`${host}/${login}`);
        if (found.has(id.toLowerCase())) return null;
        found.set(id.toLowerCase(), {
          id,
          host,
          login,
          configDir,
          name: null,
          avatarUrl: null,
          status,
        });
        return id;
      };
      for (const listing of listings) {
        if (listing._tag === "listed") {
          for (const entry of listing.logins) {
            const id = claim(listing.configDir, entry, { _tag: "ready" });
            if (id !== null && entry.active) foundActiveAccounts.add(id);
          }
          continue;
        }
        for (const entry of listing.remembered) {
          const message = failureText(listing.failure, listing.configDir, entry.login);
          const id = claim(listing.configDir, entry, { _tag: "error", message });
          if (id !== null) unreadAccounts.add(id);
        }
        if (![...found.values()].some((account) => account.configDir === listing.configDir))
          configDirProblems.push({
            configDir: listing.configDir,
            message: failureText(listing.failure, listing.configDir, null),
          });
      }
      return {
        addedConfigDirs,
        found: [...found.values()].sort((a, b) => a.id.localeCompare(b.id)),
        foundActiveAccounts,
        unreadAccounts,
        configDirProblems,
      };
    });

  const discover = () =>
    Effect.gen(function* () {
      const { addedConfigDirs, found, foundActiveAccounts, unreadAccounts, configDirProblems } =
        yield* find().pipe(Effect.tapError((error) => Deferred.fail(firstFound, error)));
      yield* Deferred.succeed(firstFound, {
        accounts: found.map(({ id, configDir, status }) => ({ id, configDir, status })),
        configDirProblems,
      });
      const freshTokens = new Map<AccountId, Redacted.Redacted<string>>();
      const accounts = yield* Effect.forEach(
        found,
        (account) =>
          unreadAccounts.has(account.id)
            ? Effect.succeed(account)
            : Effect.gen(function* () {
                const token = yield* fromGh(account, foundActiveAccounts.has(account.id));
                const profile = yield* verify(account, token);
                freshTokens.set(account.id, token);
                return { ...account, name: profile.name, avatarUrl: profile.avatar_url };
              }).pipe(
                Effect.catchTag("AccountUnavailableError", (error) =>
                  Effect.succeed({
                    ...account,
                    status: { _tag: "error" as const, message: error.message },
                  }),
                ),
              ),
        { concurrency: 4 },
      );
      tokens.clear();
      for (const [id, token] of freshTokens) tokens.set(id, token);
      activeAccounts = foundActiveAccounts;
      unreadableDirAccounts = unreadAccounts;
      current = { home, accounts, addedConfigDirs, configDirProblems };
      return current;
    });

  const refresh = () => gate.withPermits(1)(discover());
  const list = () =>
    gate.withPermits(1)(
      Effect.suspend(() => (current === null ? discover() : Effect.succeed(current))),
    );
  const token = (id: AccountId, reread = false) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const account = current?.accounts.find((entry) => entry.id === id);
        if (!account)
          return yield* new AccountUnavailableError({
            accountId: id,
            message: "This GitHub account is no longer available. Refresh Accounts in Settings.",
          });
        if (unreadableDirAccounts.has(id) && account.status._tag === "error")
          return yield* new AccountUnavailableError({
            accountId: id,
            message: account.status.message,
          });
        const cached = tokens.get(id);
        if (!reread && cached) return { account, token: cached };
        const fresh = yield* fromGh(account, activeAccounts.has(id)).pipe(
          Effect.flatMap((fresh) => verify(account, fresh).pipe(Effect.as(fresh))),
          Effect.catchTag("AccountUnavailableError", (error) => {
            tokens.delete(id);
            const failed = {
              ...account,
              status: { _tag: "error" as const, message: error.message },
            };
            if (current)
              current = {
                ...current,
                accounts: current.accounts.map((entry) => (entry.id === id ? failed : entry)),
              };
            return Effect.fail(error);
          }),
        );
        tokens.set(id, fresh);
        return { account, token: fresh };
      }),
    );

  const addConfigDir = (input: string) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const configDir = normalize(input);
        const info = yield* fs.stat(configDir).pipe(
          Effect.mapError(
            () =>
              new ConfigDirNotFoundError({
                path: configDir,
                message:
                  "This directory doesn't exist or can't be read. Check the path and try again.",
              }),
          ),
        );
        if (info.type !== "Directory")
          return yield* new ConfigDirNotFoundError({
            path: configDir,
            message: "Choose a directory, not a file.",
          });
        if (
          !(yield* fs.exists(path.join(configDir, "hosts.yml")).pipe(
            Effect.mapError(
              () =>
                new ConfigDirNoHostsError({
                  path: configDir,
                  message: "Couldn't read hosts.yml in this directory. Check its permissions.",
                }),
            ),
          ))
        )
          return yield* new ConfigDirNoHostsError({
            path: configDir,
            message:
              "This directory has no hosts.yml. Choose a gh config directory where you've logged in.",
          });
        const added = yield* readAdded();
        if (
          (yield* candidates(
            added.map((row) => row.path),
            [],
          )).dirs.includes(configDir)
        )
          return yield* new ConfigDirAlreadyAddedError({
            path: configDir,
            message: "This directory is already included in account discovery.",
          });
        yield* sql`INSERT INTO github_config_dirs (path) VALUES (${configDir}) ON CONFLICT DO NOTHING`.pipe(
          Effect.mapError(() => new AccountsError({ message: "Couldn't save this directory." })),
        );
        return yield* discover();
      }),
    );

  const removeConfigDir = (input: string) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const configDir = normalize(input);
        if (!(yield* readAdded()).some((row) => row.path === configDir))
          return yield* new ConfigDirNotAddedError({
            path: configDir,
            message: "Only directories you added in Settings can be removed.",
          });
        yield* sql`DELETE FROM github_config_dirs WHERE path = ${configDir}`.pipe(
          Effect.mapError(() => new AccountsError({ message: "Couldn't remove this directory." })),
        );
        return yield* discover();
      }),
    );

  yield* refresh().pipe(
    Effect.catchTag("AccountsError", (error) => Effect.logWarning(error.message)),
    Effect.forkScoped,
  );
  /** The accounts as last discovered, without waiting for a discovery to finish. */
  const known = Effect.sync(() => current);
  /**
   * Who the first discovery found in the gh config directories, and where, with the directories
   * it couldn't read, while GitHub verifies them. The same snapshot discovery verifies, so a
   * directory that changes in between can't put one directory's rows under an account read
   * through another.
   */
  const configured = Deferred.await(firstFound);
  return { list, known, configured, refresh, addConfigDir, removeConfigDir, token, apiBase };
});

export const layer = Layer.effect(GitHubAccounts, make);
