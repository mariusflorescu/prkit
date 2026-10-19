import type { AccountId, PullRequestRef } from "@prkit/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Base64 } from "effect/encoding";

import type { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { foreignConfigKeys } from "./cacheConfig.ts";
import { denied, fetchFailure } from "./fetchFailure.ts";
import { type GitRunner, type GitTarget, RepoError } from "./gitRun.ts";

export const repoName = (ref: PullRequestRef) => `${ref.owner}/${ref.repo}`;
/** The only remote a cache has; the user's own config never rewrites it. */
const originUrl = (ref: PullRequestRef) => `https://${ref.host}/${ref.owner}/${ref.repo}.git`;
export const diskFailure = (ref: PullRequestRef) =>
  new RepoError({
    reason: "repository",
    message: `Couldn't write prkit's copy of ${repoName(ref)}. Check the disk has space, then retry.`,
  });

/** The cache's network steps, fetch and push, with the account's token and only on prkit's own config. */
export const makeCacheRemote = ({
  fs,
  path,
  accounts,
  run,
  git,
  serialized,
  repoPath,
}: Pick<GitRunner, "run" | "git" | "serialized"> & {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly accounts: Context.Service.Shape<typeof GitHubAccounts>;
  readonly repoPath: (ref: PullRequestRef) => string;
}) => {
  const bare = (repo: string): GitTarget => ({ _tag: "bare", repo });
  const plain: GitTarget = { _tag: "plain" };

  /**
   * Refuses a fetch or push when the cache's config holds anything but prkit's own keys and
   * values (`cacheConfig.ts`): a planted `include.path`, `url.*.insteadOf` or filter could make
   * git run a program or send the account's token to another server. git reads the file
   * itself, without following includes, so a quirk of its syntax can't hide a key.
   */
  const refuseForeignConfig = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      const listed = yield* git(
        ["config", "--file", path.join(repoPath(ref), "config"), "--no-includes", "--list", "-z"],
        {
          target: plain,
          failure: `Couldn't read the settings of prkit's copy of ${repoName(ref)}.`,
        },
      );
      const foreign = foreignConfigKeys(listed, originUrl(ref));
      if (foreign.length > 0)
        return yield* new RepoError({
          reason: "repository",
          message: `prkit stopped and needs you: prkit's copy of ${repoName(ref)} has git settings prkit didn't write (${foreign.slice(0, 5).join(", ")}), which could make git run a program or send your token to another server. Nothing was fetched or pushed. Delete ${repoPath(ref)} and retry, and prkit makes a fresh copy.`,
        });
    });

  /**
   * Network commands only, and only once the cache's config is prkit's own. The token travels
   * in the child's environment, never in argv, a config file or a URL. A refusal re-reads the
   * account's token once.
   */
  const authenticated = (
    accountId: AccountId,
    args: ReadonlyArray<string>,
    options: {
      readonly ref: PullRequestRef;
      readonly input?: string;
      readonly env?: Readonly<Record<string, string>>;
    },
  ) =>
    Effect.gen(function* () {
      yield* refuseForeignConfig(options.ref);
      const attempt = (reread: boolean) =>
        Effect.gen(function* () {
          const binding = yield* accounts.token(accountId, reread);
          const header = `Authorization: Basic ${Base64.encode(`x-access-token:${Redacted.value(binding.token)}`)}`;
          return {
            login: binding.account.login,
            result: yield* run(args, {
              target: bare(repoPath(options.ref)),
              env: {
                ...options.env,
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "http.extraHeader",
                GIT_CONFIG_VALUE_0: header,
              },
              ...(options.input === undefined ? {} : { input: options.input }),
            }),
          };
        });
      const first = yield* attempt(false);
      return first.result.code !== 0 && denied(first.result.stderr) ? yield* attempt(true) : first;
    });

  const FETCH = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--filter=blob:none"];

  /**
   * Refs are negotiated: the cache holds every commit and tree its refs reach. Objects
   * are fetched by id with no haves, as git's own lazy fetch does: the cache lacks most
   * blobs its commits reach, and a server told otherwise leaves out blobs asked for or
   * sends them as deltas against blobs the cache never had.
   */
  const fetch = (
    ref: PullRequestRef,
    accountId: AccountId,
    what: string,
    request:
      | { readonly refspecs: ReadonlyArray<string> }
      | { readonly objects: ReadonlyArray<string> },
  ) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("git fetch").pipe(
        Effect.annotateLogs({ accountId, repo: repoName(ref), what }),
      );
      const { login, result } = yield* "refspecs" in request
        ? authenticated(accountId, [...FETCH, "origin", ...request.refspecs], { ref })
        : authenticated(
            accountId,
            ["-c", "fetch.negotiationAlgorithm=noop", ...FETCH, "--stdin", "origin"],
            { ref, input: `${request.objects.join("\n")}\n` },
          );
      if (result.code === 0) return;
      const stderr = result.stderr.trim();
      yield* Effect.logWarning("git fetch failed").pipe(
        Effect.annotateLogs({ accountId, repo: repoName(ref), what, stderr }),
      );
      return yield* new RepoError(
        fetchFailure(stderr, {
          login,
          repo: repoName(ref),
          refspec: "refspecs" in request ? (request.refspecs.at(-1) ?? "") : "",
        }),
      );
    }).pipe(
      Effect.interruptible,
      Effect.timeout("2 minutes"),
      Effect.catchTag("TimeoutError", () =>
        Effect.logWarning("GitHub fetch reached its deadline").pipe(
          Effect.annotateLogs({ accountId, repo: repoName(ref), what, timeoutMs: 120_000 }),
          Effect.andThen(
            Effect.fail(
              new RepoError({
                reason: "repository",
                message: `GitHub took too long to fetch ${repoName(ref)}. Check your connection, then retry.`,
              }),
            ),
          ),
        ),
      ),
      Effect.catchTag("AccountUnavailableError", (error) =>
        Effect.fail(new RepoError({ reason: "account", message: error.message })),
      ),
    );

  const ensureCache = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      const repo = repoPath(ref);
      yield* fs.makeDirectory(repo, { recursive: true });
      // Re-running init and config on an existing cache changes nothing.
      yield* git(["init", "--quiet", "--bare", repo], { target: plain });
      for (const [key, value] of [
        ["remote.origin.url", originUrl(ref)],
        ["remote.origin.promisor", "true"],
        ["remote.origin.partialclonefilter", "blob:none"],
      ] as const)
        yield* git(["config", key, value], { target: bare(repo) });
      return repo;
    });

  /**
   * Fetches every object `rev-list --objects <args>` names that the blobless cache
   * lacks, in one request, so what runs next never needs the network.
   */
  const prefetch = (
    ref: PullRequestRef,
    accountId: AccountId,
    repo: string,
    [args, what]: readonly [ReadonlyArray<string>, string],
  ) =>
    Effect.gen(function* () {
      const listed = yield* git(["rev-list", "--objects", "--missing=print", ...args], {
        target: bare(repo),
      });
      const missing = listed
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .map((line) => line.slice(1));
      if (missing.length > 0)
        yield* fetch(ref, accountId, `${missing.length} blobs of the ${what}`, {
          objects: missing,
        });
    });

  /**
   * Pushes `sha` to the PR's branch, only if the branch is still at `expected`:
   * a normal push for new commits, a force-push with lease for a rebase. The branch
   * moving first is an answer, not an error; prkit never pushes over it.
   */
  const pushFix = (input: {
    readonly ref: PullRequestRef;
    readonly accountId: AccountId;
    /** `owner/repo` the head branch lives in. */
    readonly headRepo: string;
    readonly headRef: string;
    readonly sha: string;
    readonly expected: string;
    readonly lease: boolean;
  }) =>
    serialized(repoPath(input.ref))(
      Effect.gen(function* () {
        yield* ensureCache(input.ref);
        const url = `https://${input.ref.host}/${input.headRepo}.git`;
        const branch = `refs/heads/${input.headRef}`;
        const listed = yield* authenticated(input.accountId, ["ls-remote", url, branch], {
          ref: input.ref,
        });
        if (listed.result.code !== 0) {
          yield* Effect.logWarning("git ls-remote failed").pipe(
            Effect.annotateLogs({ repo: input.headRepo, stderr: listed.result.stderr.trim() }),
          );
          return yield* new RepoError({
            reason: denied(listed.result.stderr) ? "account" : "repository",
            message: `Couldn't read ${input.headRepo} on GitHub as ${listed.login}. Check your connection, then push again.`,
          });
        }
        const remote = listed.result.stdout.split("\t")[0]?.trim() || null;
        // An earlier push that prkit lost track of (a crash mid-push) already landed.
        if (remote === input.sha) return { _tag: "pushed" } as const;
        if (remote !== input.expected) return { _tag: "moved", remote } as const;
        yield* Effect.logInfo("git push").pipe(
          Effect.annotateLogs({
            accountId: input.accountId,
            repo: input.headRepo,
            branch: input.headRef,
            lease: input.lease,
          }),
        );
        const pushed = yield* authenticated(
          input.accountId,
          [
            "push",
            "--quiet",
            "--no-verify",
            ...(input.lease ? [`--force-with-lease=${branch}:${input.expected}`] : []),
            url,
            `${input.sha}:${branch}`,
          ],
          // A fork may lack base commits a merge brings; let git fetch their blobs.
          { ref: input.ref, env: { GIT_NO_LAZY_FETCH: "0" } },
        );
        if (pushed.result.code === 0) return { _tag: "pushed" } as const;
        const stderr = pushed.result.stderr.trim();
        yield* Effect.logWarning("git push failed").pipe(
          Effect.annotateLogs({ repo: input.headRepo, stderr }),
        );
        if (
          /non-fast-forward|stale info|fetch first|rejected/i.test(stderr) &&
          !/protected/i.test(stderr)
        )
          return { _tag: "moved", remote: null } as const;
        return yield* new RepoError({
          reason: denied(stderr) || /permission|403/i.test(stderr) ? "account" : "repository",
          message: /protected branch|GH006/i.test(stderr)
            ? `${input.headRepo} protects ${input.headRef}, so GitHub refused the push. Copy the patch instead.`
            : /permission|403/i.test(stderr)
              ? `GitHub refused ${pushed.login}'s push to ${input.headRepo}. Copy the patch instead.`
              : `GitHub refused the push to ${input.headRepo}: ${stderr.split("\n").at(-1) ?? "unknown error"}`,
        });
      }),
    ).pipe(
      Effect.timeout("2 minutes"),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.fail(
            new RepoError({
              reason: "repository",
              message:
                "GitHub took too long to take the push. Check your connection, then push again.",
            }),
          ),
        AccountUnavailableError: (error) =>
          Effect.fail(new RepoError({ reason: "account", message: error.message })),
        PlatformError: () => Effect.fail(diskFailure(input.ref)),
      }),
    );

  return { ensureCache, fetch, prefetch, pushFix };
};
