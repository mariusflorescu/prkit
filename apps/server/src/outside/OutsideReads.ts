import {
  type DiffSnapshot,
  forReader,
  PullRequestFile,
  PullRequestCandidates,
  type ReviewSnapshot,
  ignoreMatcher,
  resolveGuideConfig,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import { Agents } from "../agents/Agents.ts";
import { AppearanceStore } from "../appearance/AppearanceStore.ts";
import { Fixers } from "../fixers/Fixers.ts";
import { FixerSettingsStore } from "../fixers/FixerSettingsStore.ts";
import { GitHubApi } from "../github/GitHubApi.ts";
import { PullRequests } from "../pullRequests/PullRequests.ts";
import { makeReadCache } from "../pullRequests/readCache.ts";
import * as Schema from "effect/Schema";
import { GuideConfigStore } from "../reviews/GuideConfigStore.ts";
import { GuideSettingsStore } from "../reviews/GuideSettingsStore.ts";
import { ManualCheckTicks } from "../manualCheck/ManualCheckTicks.ts";
import { ReviewedFiles } from "../reviewedFiles/ReviewedFiles.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { OutsideAgents } from "./OutsideAgents.ts";
import { asFailure, fail } from "./errors.ts";
import { resultJson } from "./responses.ts";
import { makePager, textParts, type PageInput } from "./paging.ts";
import type * as Inputs from "./paritySchemas.ts";
import type { GuideStatus, OutsideToolFailure, Target, TargetInput } from "./schemas.ts";

export type ResolveTarget = (
  input: TargetInput,
) => Effect.Effect<typeof Target.Type, OutsideToolFailure>;

/** Large text patches are returned as numbered fragments, including every character. */
const fileParts = (
  files: ReadonlyArray<typeof PullRequestFile.Type | DiffSnapshot["files"][number]>,
) =>
  files.flatMap((file): Array<typeof Inputs.FilePart.Type> => {
    const patch = file.patch;
    return patch._tag !== "text"
      ? [{ ...file, offset: 0, complete: true }]
      : textParts(patch.patch).map((part) =>
          Object.assign({}, file, {
            patch: { _tag: "text" as const, patch: part.text },
            offset: part.offset,
            complete: part.offset + part.text.length === patch.patch.length,
          }),
        );
  });

export const makeOutsideReads = (
  resolve: ResolveTarget,
  guideStatusOf: (snapshot: ReviewSnapshot) => GuideStatus,
) =>
  Effect.gen(function* () {
    const page = yield* makePager;
    const accounts = yield* GitHubAccounts;
    const api = yield* GitHubApi;
    const agents = yield* Agents;
    const pulls = yield* PullRequests;
    const reviews = yield* Reviews;
    const reviewed = yield* ReviewedFiles;
    const manualCheckTicks = yield* ManualCheckTicks;
    const fixes = yield* Fixers;
    const guideConfig = yield* GuideConfigStore;
    const guideSettings = yield* GuideSettingsStore;
    const fixSettings = yield* FixerSettingsStore;
    const appearance = yield* AppearanceStore;
    const outside = yield* OutsideAgents;
    const candidateCache = yield* makeReadCache({
      name: "outside-candidates",
      json: Schema.fromJsonString(PullRequestCandidates),
      maxEntries: 64,
      maxBytes: 2 * 1024 * 1024,
      freshMs: 10 * 60_000,
      persist: false,
      changed: () => Effect.void,
    });

    const refreshedTarget = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        if (input.refresh === true && input.cursor === undefined)
          yield* pulls.refresh(target.key, target.accountId);
        return target;
      });
    const repositoryAccount = (input: typeof Inputs.RepositoryInput.Type) =>
      Effect.gen(function* () {
        const host = (input.host ?? "github.com").toLowerCase();
        const known = (yield* accounts.list()).accounts.filter((account) => account.host === host);
        if (input.accountId !== undefined) {
          const account = known.find((entry) => entry.id === input.accountId);
          if (account === undefined || account.status._tag !== "ready")
            return yield* fail(
              "account-needed",
              `Choose an account on ${host}: ${known.map((entry) => entry.id).join(", ") || "none"}.`,
            );
          return account;
        }
        const ready = known.filter((account) => account.status._tag === "ready");
        if (ready.length === 1 && ready[0] !== undefined) return ready[0];
        return yield* fail(
          "account-needed",
          `Pass accountId for this repository. Accounts on ${host}: ${known.map((entry) => entry.id).join(", ") || "none"}.`,
        );
      });
    const listAccounts = (input: typeof Inputs.ListInput.Type) =>
      Effect.gen(function* () {
        const list = yield* accounts.list();
        const budget = yield* api.budget;
        const rows = list.accounts
          .filter((entry) => input.accountId === undefined || entry.id === input.accountId)
          .map((account) => ({
            accountId: account.id,
            login: account.login,
            host: account.host,
            ready: account.status._tag === "ready",
            problem: account.status._tag === "error" ? account.status.message : null,
            budget: budget.accounts.find((entry) => entry.accountId === account.id)?.limits ?? [],
          }));
        return yield* page(rows, input, `accounts:${input.accountId ?? "all"}`);
      }).pipe(Effect.mapError(asFailure));

    const repositories = (input: typeof Inputs.RefreshListInput.Type) =>
      Effect.gen(function* () {
        const list = yield* pulls.repositories(
          input.refresh === true && input.cursor === undefined
            ? { _tag: "refresh" }
            : { _tag: "cached" },
        );
        const rows = list.repositories.filter(
          (entry) => input.accountId === undefined || entry.accountIds.includes(input.accountId),
        );
        return {
          ...(yield* page(
            rows,
            input,
            `repositories:${input.accountId ?? "all"}:${rows.map((entry) => `${entry.host}/${entry.owner}/${entry.name}`).join(",")}`,
          )),
          accounts: list.accounts.filter(
            (entry) => input.accountId === undefined || entry.accountId === input.accountId,
          ),
        };
      }).pipe(Effect.mapError(asFailure));

    const repositoryPullRequests = (input: typeof Inputs.RepositoryInput.Type) =>
      Effect.gen(function* () {
        const account = yield* repositoryAccount(input);
        const list = yield* pulls.repositoryPullRequests(
          account.id,
          account.host,
          input.owner,
          input.repo,
          input.refresh === true && input.cursor === undefined,
        );
        return {
          ...(yield* page(
            list.entries,
            input,
            `repository-prs:${account.id}:${input.owner}/${input.repo}:${list.entries.map((entry) => `${entry.ref.number}:${entry.updatedAt}`).join(",")}`,
          )),
          githubTotal: list.total,
          freshness: list.freshness,
        };
      }).pipe(Effect.mapError(asFailure));

    const catalog = (input: typeof Inputs.AgentsInput.Type) =>
      Effect.gen(function* () {
        const list = yield* agents.catalog(
          input.refresh === true && input.cursor === undefined,
          input.instance,
        );
        const rows = list.providers
          .filter((entry) => input.instance === undefined || entry.instance === input.instance)
          .map((entry) => ({
            instance: entry.instance,
            kind: entry.kind,
            label: entry.label,
            enabled: entry.enabled,
            isDefault: entry.isDefault,
            version: entry.version,
            ready: entry.state._tag === "ready",
            problem: entry.state._tag === "unavailable" ? entry.state.message : null,
            models: entry.models,
          }));
        return yield* page(rows, input, `agents:${input.instance ?? "all"}`);
      }).pipe(Effect.mapError(asFailure));

    const files = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const result = yield* pulls.files(target.key, target.accountId);
        const identity = yield* pulls.fileDiffIdentity(target.key, target.accountId);
        return {
          ...(yield* page(
            fileParts(result.files),
            input,
            `files:${target.accountId}:${target.key}:${resultJson(identity)}`,
          )),
          headSha: result.headSha,
          baseSha: result.baseSha,
          changedFiles: result.changedFiles,
          githubTruncated: result.files.length < result.changedFiles,
        };
      }).pipe(Effect.mapError(asFailure));

    const reviewedFiles = (input: typeof Inputs.ReviewedFilesInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const result = yield* reviewed.report(target, input.revision);
        return {
          ...(yield* page(
            result.files,
            input,
            `reviewed-files:${target.accountId}:${target.key}:${result.revision ?? "live"}:${result.headSha}`,
          )),
          headSha: result.headSha,
          revision: result.revision,
          changedFiles: result.changedFiles,
          githubTruncated: result.githubTruncated,
          progress: result.progress,
          chapters: result.chapters,
        };
      }).pipe(Effect.mapError(asFailure));

    const fileContents = (input: typeof Inputs.FileInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const result = yield* pulls.fileContents(
          target.key,
          target.accountId,
          input.path,
          input.side,
        );
        return {
          ...(yield* page(
            textParts(result.content),
            input,
            `contents:${target.accountId}:${target.key}:${input.path}:${input.side}:${result.sha}`,
          )),
          sha: result.sha,
        };
      }).pipe(Effect.mapError(asFailure));

    const timeline = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const result = yield* pulls.timeline(target.key, target.accountId);
        return {
          ...(yield* page(result.events, input, `timeline:${target.accountId}:${target.key}`)),
          githubTruncated: false,
        };
      }).pipe(Effect.mapError(asFailure));

    const threads = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const result = yield* pulls.threads(target.key, target.accountId);
        return {
          ...(yield* page(
            result.threads,
            input,
            `threads:${target.accountId}:${target.key}:${result.headSha}`,
          )),
          githubTruncated: result.truncated,
        };
      }).pipe(Effect.mapError(asFailure));

    const checks = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const detail = yield* pulls.detail(target.key, target.accountId);
        return yield* page(
          detail.checks,
          input,
          `checks:${target.accountId}:${target.key}:${detail.headSha}`,
        );
      }).pipe(Effect.mapError(asFailure));

    const conversation = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const detail = yield* pulls.detail(target.key, target.accountId);
        return yield* page(
          detail.conversation,
          input,
          `conversation:${target.accountId}:${target.key}`,
        );
      }).pipe(Effect.mapError(asFailure));

    const stack = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* refreshedTarget(input);
        const result = yield* pulls.stack(target.key, target.accountId);
        return {
          ...(yield* page(
            result?.layers ?? [],
            input,
            `stack:${target.accountId}:${target.key}:${result?.number ?? "none"}`,
          )),
          stack: result === null ? null : { number: result.number, base: result.base },
        };
      }).pipe(Effect.mapError(asFailure));

    const candidates = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const account = (yield* accounts.list()).accounts.find(
          (entry) => entry.id === target.accountId,
        );
        if (account === undefined || account.status._tag !== "ready")
          return yield* fail(
            "account-needed",
            "This account was removed. Choose an account from list_accounts.",
          );
        const result = yield* candidateCache.read(
          { accountId: account.id, configDir: account.configDir, key: target.key },
          pulls.candidates(target.key, account.id),
          { refresh: input.refresh === true && input.cursor === undefined },
        );
        const items = [
          ...result.value.reviewers.map((entry) =>
            Object.assign({ _tag: "reviewer" as const }, entry),
          ),
          ...result.value.teams.map((entry) => Object.assign({ _tag: "team" as const }, entry)),
          ...result.value.labels.map((entry) => Object.assign({ _tag: "label" as const }, entry)),
        ];
        return yield* page(items, input, `candidates:${target.accountId}:${target.key}`);
      }).pipe(Effect.mapError(asFailure));

    const listReviews = (input: typeof Inputs.ListInput.Type) =>
      Effect.gen(function* () {
        return yield* page(
          (yield* reviews.index())
            .filter((entry) => input.accountId === undefined || entry.accountId === input.accountId)
            .toSorted((a, b) => a.key.localeCompare(b.key)),
          input,
          `reviews:${input.accountId ?? "all"}`,
        );
      }).pipe(Effect.mapError(asFailure));

    const revisions = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        return yield* page(
          (yield* reviews.get(target.key)).revisions,
          input,
          `revisions:${target.key}`,
        );
      }).pipe(Effect.mapError(asFailure));

    const revision = (input: typeof Inputs.RevisionInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const stored = yield* reviews.guide(target.key, input.revision);
        const { review } = yield* reviews.get(target.key);
        const guide =
          review === null ? stored : forReader(stored, review.accountId, target.accountId);
        return {
          revision: guide.revision,
          headSha: guide.headSha,
          createdAt: guide.createdAt,
          content: guide.normalized,
          config: guide.config,
          ...(yield* manualCheckTicks.numbers(
            { _tag: "pull-request", key: target.key, accountId: target.accountId },
            guide,
          )),
        };
      }).pipe(Effect.mapError(asFailure));

    const progress = (input: typeof Inputs.PagedTargetInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const snapshot = yield* reviews.get(target.key);
        const draft =
          snapshot.attempt?.draft === null || snapshot.attempt === null
            ? null
            : yield* reviews.draft(target.key, snapshot.attempt.id);
        return {
          status: guideStatusOf(snapshot),
          attempt: snapshot.attempt,
          ...(yield* page(
            snapshot.activity,
            input,
            `progress:${target.key}:${resultJson([snapshot, draft])}`,
          )),
          draft,
        };
      }).pipe(Effect.mapError(asFailure));

    const reviewDiff = (input: typeof Inputs.ReviewDiffInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const diff = yield* reviews.diff(target.key, input.attemptId);
        const saved = yield* reviews.get(target.key);
        const attempt = saved.attempt;
        return {
          ...(yield* page(
            fileParts(diff.files),
            input,
            `review-diff:${target.key}:${input.attemptId}`,
          )),
          headSha:
            attempt?.id === input.attemptId
              ? attempt.headSha
              : (saved.revisions.find((revision) => revision.attemptId === input.attemptId)
                  ?.headSha ?? null),
          baseSha: null,
          changedFiles: diff.files.length,
          githubTruncated: false,
        };
      }).pipe(Effect.mapError(asFailure));

    const duration = (input: typeof Inputs.DurationInput.Type) =>
      reviews.typicalDuration(input.instance, input.lines).pipe(
        Effect.map((duration) => ({ duration })),
        Effect.mapError(asFailure),
      );

    const guideSettingsFor = (input: TargetInput) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const scopes = yield* guideConfig.forPullRequest(target.key, target.accountId);
        const resolved = resolveGuideConfig({
          global: scopes.global,
          repository: scopes.repositoryConfig,
          pullRequest: scopes.pullRequest,
        });
        const files = yield* pulls.files(target.key, target.accountId);
        const match = ignoreMatcher(resolved.ignore);
        const skipped = files.files.flatMap((file) => {
          const decision = match(file);
          return decision.skipped
            ? [
                {
                  path: file.path,
                  previousPath: file.previousPath,
                  additions: file.additions,
                  deletions: file.deletions,
                  reasons: decision.sides.flatMap((side) =>
                    side.winner === null
                      ? []
                      : [
                          {
                            path: side.path,
                            pattern: side.winner.pattern,
                            scope: side.winner.scope,
                          },
                        ],
                  ),
                },
              ]
            : [];
        });
        return { scopes, resolved, skipped, reviewedFiles: files.files.length - skipped.length };
      }).pipe(Effect.mapError(asFailure));

    const guideScope = (input: typeof Inputs.ScopeInput.Type) =>
      guideConfig.scope(input.scope).pipe(Effect.mapError(asFailure));
    const guideRepositories = (input: PageInput) =>
      guideConfig.repositories().pipe(
        Effect.flatMap((rows) => page(rows, input, "guide-repositories")),
        Effect.mapError(asFailure),
      );
    const findGuideRepository = (input: typeof Inputs.RepositoryInput.Type) =>
      Effect.gen(function* () {
        const account = yield* repositoryAccount(input);
        return yield* guideConfig.findRepository({
          accountId: account.id,
          host: account.host,
          owner: input.owner,
          name: input.repo,
        });
      }).pipe(Effect.mapError(asFailure));

    const listFixes = (input: typeof Inputs.ListInput.Type) =>
      Effect.gen(function* () {
        const opening = yield* fixes.feed().pipe(Stream.runHead);
        const rows =
          Option.isSome(opening) && opening.value._tag === "index" ? opening.value.fixers : [];
        return yield* page(
          rows
            .filter((entry) => input.accountId === undefined || entry.accountId === input.accountId)
            .toSorted((a, b) => a.key.localeCompare(b.key)),
          input,
          `fixes:${input.accountId ?? "all"}`,
        );
      }).pipe(Effect.mapError(asFailure));
    const fixTurn = (input: typeof Inputs.FixTurnInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const snapshot = yield* fixes.history(target.key);
        const turn = snapshot.turns.find((entry) => entry.id === input.turnId);
        if (turn === undefined)
          return yield* fail(
            "not-found",
            "This fix turn wasn't found on this pull request. Read read_fix for its turn ids.",
          );
        return {
          turn,
          ...(yield* page(
            yield* fixes.turnActivity(target.key, turn.id),
            input,
            `fix-turn:${target.key}:${resultJson([turn, snapshot.settings])}`,
          )),
          settings: snapshot.settings,
          autoResolvePaused: snapshot.autoResolvePaused,
        };
      }).pipe(Effect.mapError(asFailure));
    const fixDiff = (input: typeof Inputs.FixDiffInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const diff = yield* fixes.diff(target.key, input.turnId);
        const side = input.side ?? "ours";
        const files =
          diff._tag === "commit"
            ? diff.diff.files
            : side === "ours"
              ? diff.ours.files
              : diff.theirs.files;
        return {
          ...(yield* page(
            fileParts(files),
            input,
            `fix-diff:${target.key}:${input.turnId}:${side}`,
          )),
          kind: diff._tag,
          side,
        };
      }).pipe(Effect.mapError(asFailure));
    const fixPatch = (input: typeof Inputs.FixTurnInput.Type) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        const result = yield* fixes.patch(target.key, input.turnId);
        return {
          ...(yield* page(
            textParts(result.patch),
            input,
            `fix-patch:${target.key}:${input.turnId}`,
          )),
          sha: null,
        };
      }).pipe(Effect.mapError(asFailure));
    const fixAccess = (input: TargetInput) =>
      Effect.gen(function* () {
        const target = yield* resolve(input);
        return {
          push: yield* fixes.pushAccess(target.key, target.accountId),
          scripts: yield* fixes.scriptAccess(target.key, target.accountId),
        };
      }).pipe(Effect.mapError(asFailure));
    const settings = (input: PageInput) =>
      Effect.gen(function* () {
        return {
          guides: yield* guideSettings.get(),
          appearance: yield* appearance.get(),
          outside: yield* outside.get(),
          ...(yield* page(yield* fixSettings.list(), input, "fix-settings")),
        };
      }).pipe(Effect.mapError(asFailure));

    return {
      listAccounts,
      repositories,
      repositoryPullRequests,
      catalog,
      files,
      reviewedFiles,
      fileContents,
      timeline,
      threads,
      checks,
      conversation,
      stack,
      candidates,
      listReviews,
      revisions,
      revision,
      progress,
      reviewDiff,
      duration,
      guideSettingsFor,
      guideScope,
      guideRepositories,
      findGuideRepository,
      listFixes,
      fixTurn,
      fixDiff,
      fixPatch,
      fixAccess,
      settings,
    };
  });
