import { AccountId, type GitHubResource } from "@prkit/contracts";
import * as Undici from "@effect/platform-node/Undici";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { GitHubAccounts } from "../accounts/GitHubAccounts.ts";
import {
  admit,
  isoAt,
  pause,
  pauseUntil,
  type Priority,
  record,
  type ResourceBudget,
  toLimit,
} from "./budget.ts";
import { makeKeyedGate } from "./keyedGate.ts";

type GitHubJson =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: GitHubJson }
  | readonly GitHubJson[];

/**
 * Why a read failed. Only `unauthorized` means the account itself is broken (its
 * token was refused after one re-read); the others are about this request.
 * `rate-limited` and `reserved` were never sent: the account is paused, or a
 * background read would dip into the share kept for clicks.
 */
export const GitHubFailure = Schema.Literals([
  "unauthorized",
  "not-found",
  "rate-limited",
  "reserved",
  "network",
  "rejected",
]);
export type GitHubFailure = typeof GitHubFailure.Type;

export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()(
  "GitHubRequestError",
  {
    accountId: AccountId,
    reason: GitHubFailure,
    message: Schema.String,
    status: Schema.NullOr(Schema.Int),
    /** Epoch milliseconds GitHub takes this account's requests again, for `rate-limited` and `reserved`. */
    resetAt: Schema.optionalKey(Schema.Number),
  },
) {}

/** Clicks go while budget remains; reads nobody clicked for pass this as `background`. */
export const GitHubPriority = Context.Reference<Priority>(
  "@prkit/server/github/GitHubApi/GitHubPriority",
  { defaultValue: () => "interactive" },
);
export const inBackground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, GitHubPriority, "background");

/** One entry of a GraphQL `errors` array; `path[0]` is the alias it belongs to. */
export const GraphQLError = Schema.Struct({
  message: Schema.String,
  type: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Int]))),
  /** `undefinedField` names a field this host's schema doesn't have. */
  extensions: Schema.optionalKey(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      fieldName: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type GraphQLError = typeof GraphQLError.Type;

/** GitHub's GraphQL error types, as the read failure they stand for. */
export const graphQLFailure = (error: GraphQLError): GitHubFailure =>
  error.type === "NOT_FOUND" || error.type === "FORBIDDEN"
    ? "not-found"
    : error.type === "RATE_LIMITED"
      ? "rate-limited"
      : "rejected";

/** A query GitHub answered without data or with errors, as the read failure it stands for. */
export const queryFailure = (accountId: AccountId, errors: ReadonlyArray<GraphQLError>) =>
  new GitHubRequestError({
    accountId,
    reason: errors[0] === undefined ? "rejected" : graphQLFailure(errors[0]),
    status: null,
    message: `GitHub couldn't complete the query. ${errors.length > 0 ? errors.map((error) => error.message).join(" ") : "Try refreshing."}`,
  });

const RejectedBody = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    errors: Schema.optionalKey(
      Schema.Array(
        Schema.Union([
          Schema.String,
          Schema.Struct({ message: Schema.optionalKey(Schema.String) }),
        ]),
      ),
    ),
  }),
);
const decodeRejectedBody = Schema.decodeOption(RejectedBody);

/**
 * What GitHub said about a refused request. A 422 carries its reason in `errors`
 * ("Line could not be resolved") and only "Unprocessable Entity" in `message`.
 */
const refusal = (body: string) => {
  const decoded = Option.getOrNull(decodeRejectedBody(body));
  if (decoded === null) return "";
  const details = (decoded.errors ?? []).flatMap((error) =>
    typeof error === "string" ? [error] : error.message === undefined ? [] : [error.message],
  );
  return details.length > 0 ? details.join(" ") : (decoded.message ?? "");
};

/** A non-2xx answer that isn't a rate limit, after the one token re-read on 401. */
const statusFailure = (status: number, login: string) => {
  if (status === 401)
    return {
      reason: "unauthorized",
      message: `GitHub refused ${login}'s token. Refresh the account in Settings, then retry.`,
    } as const;
  if (status >= 500)
    return {
      reason: "network",
      message: `GitHub is temporarily unavailable for ${login} (HTTP ${status}). Try refreshing in a moment.`,
    } as const;
  return {
    reason: status === 403 || status === 404 ? "not-found" : "rejected",
    message: `GitHub couldn't read pull requests for ${login} (HTTP ${status}). Check this account's access in Settings and retry.`,
  } as const;
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const usedUp = (login: string, until: number) =>
  `GitHub's limit for ${login} is used up until ${clock.format(until)}.`;
/** `AccountId` is `${host}/${login}`. */
const loginOf = (id: AccountId) => id.slice(id.indexOf("/") + 1);
const hostOf = (id: AccountId) => id.slice(0, id.indexOf("/"));

/** A query as text, or built with or without stack fields for hosts that may lack them. */
export type GraphQLQuery = string | ((stacks: boolean) => string);
/** GitHub Enterprise Server rejects a query that asks for stacks as a whole. */
const missingStacks = (error: GraphQLError) =>
  error.extensions?.code === "undefinedField" &&
  (error.extensions.fieldName === "stack" || error.extensions.fieldName === "stackEntry");

/**
 * Every GraphQL query also asks for its own cost, so "points spent" is GitHub's
 * figure. Mutations can't select `rateLimit`; they count as GitHub's minimum of one.
 */
const COST_ALIAS = "prkitRateLimit";
const withCost = (query: string) =>
  query.trimStart().startsWith("query")
    ? query.replace("{", `{ ${COST_ALIAS}: rateLimit { cost } `)
    : query;
const decodeCost = Schema.decodeUnknownOption(Schema.Struct({ cost: Schema.Int }));
const GraphQLBody = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
  errors: Schema.optionalKey(Schema.Array(GraphQLError)),
});
const encodeVariables = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const pointsOf = (cost: Schema.Json | undefined) =>
  Option.match(decodeCost(cost), { onNone: () => 1, onSome: (value) => value.cost });

/** A query's name (`PrkitWatch`), or its kind and first field (`mutation mergePullRequest`). */
export const operationOf = (query: string) => {
  const [, kind, name, field] = /^\s*(query|mutation)\s*(\w*)[^{]*\{\s*(\w+)/.exec(query) ?? [];
  return name ? name : kind === undefined ? "graphql" : `${kind} ${field ?? ""}`;
};

const issues = SchemaIssue.makeFormatterStandardSchemaV1();
/** Where the first decode failure is and what was expected, without any value from the response. */
const decodeProblem = (error: Schema.SchemaError) => {
  const [first] = issues(error.issue).issues;
  return {
    path: (first?.path ?? [])
      .map((segment) => String(typeof segment === "object" ? segment.key : segment))
      .join("."),
    problem: first?.message ?? "unreadable",
  };
};

export class GitHubApi extends Context.Service<GitHubApi, Effect.Success<typeof make>>()(
  "@prkit/server/github/GitHubApi",
) {}

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const accounts = yield* GitHubAccounts;
  const withAccount = makeKeyedGate<AccountId>(4);
  const budgets = new Map<AccountId, Map<GitHubResource, ResourceBudget>>();
  const budgetOf = (id: AccountId, resource: GitHubResource) => budgets.get(id)?.get(resource);
  const setBudget = (id: AccountId, resource: GitHubResource, next: ResourceBudget | undefined) => {
    if (next === undefined) return;
    const forAccount = budgets.get(id) ?? new Map<GitHubResource, ResourceBudget>();
    forAccount.set(resource, next);
    budgets.set(id, forAccount);
  };

  /**
   * Reads whose last answer didn't decode, so each break logs once: the account, the
   * query and its variables, since one query (`PrkitWatch`) reads many batches and
   * another (`PrkitTimeline`) carries its pull request in the query text.
   */
  const unreadable = new Set<string>();

  /**
   * One request through the account's gate and its budget. Answers a 2xx or a 304
   * response; every other answer is an error. Every answer logs the account it went
   * through, so the server log shows which account read what. `points` reads a
   * GraphQL answer's cost from its body.
   */
  const exchange = <A>(
    id: AccountId,
    resource: GitHubResource,
    operation: string,
    request: (base: string) => HttpClientRequest.HttpClientRequest,
    read: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, Schema.SchemaError | HttpClientError.HttpClientError>,
    points?: (value: A) => number,
  ) => {
    const fail = (
      reason: GitHubFailure,
      message: string,
      status: number | null = null,
      resetAt?: number,
    ) =>
      new GitHubRequestError({
        accountId: id,
        reason,
        message,
        status,
        ...(resetAt === undefined ? {} : { resetAt }),
      });
    return withAccount(
      id,
      Effect.gen(function* () {
        const priority = yield* GitHubPriority;
        let binding = yield* accounts.token(id);
        const login = binding.account.login;
        let reread = false;
        let rateRetries = 0;
        while (true) {
          const now = yield* Clock.currentTimeMillis;
          const admission = admit(budgetOf(id, resource), priority, now);
          if (admission._tag === "paused")
            return yield* fail(
              "rate-limited",
              usedUp(login, admission.until),
              null,
              admission.until,
            );
          if (admission._tag === "reserved")
            return yield* fail(
              "reserved",
              `prkit keeps the rest of ${login}'s GitHub limit for your clicks until ${clock.format(admission.until)}.`,
              null,
              admission.until,
            );
          const built = request(accounts.apiBase(binding.account.host)).pipe(
            HttpClientRequest.bearerToken(binding.token),
            HttpClientRequest.setHeaders({
              "user-agent": "prkit",
              "x-github-api-version": "2022-11-28",
              accept: "application/vnd.github+json",
            }),
          );
          const response = yield* http.execute(built);
          const at = yield* Clock.currentTimeMillis;
          const spent = resource === "core" && response.status !== 304 ? 1 : 0;
          setBudget(id, resource, record(budgetOf(id, resource), response.headers, spent, at));
          const logRequest = (cost: number) =>
            Effect.logInfo("GitHub request").pipe(
              Effect.annotateLogs({
                accountId: id,
                operation,
                status: response.status,
                cost,
                priority,
              }),
            );
          if (response.status === 304 || (response.status >= 200 && response.status < 300)) {
            const value = yield* read(response).pipe(Effect.tapError(() => logRequest(spent)));
            yield* logRequest(
              points === undefined || response.status === 304 ? spent : points(value),
            );
            return value;
          }
          const rejectedBody = yield* response.text;
          yield* logRequest(spent);
          if (response.status === 401 && !reread) {
            binding = yield* accounts.token(id, true);
            reread = true;
            continue;
          }
          if (response.status === 403 || response.status === 429) {
            const rateLimited =
              response.status === 429 ||
              response.headers["retry-after"] !== undefined ||
              response.headers["x-ratelimit-remaining"] === "0" ||
              /rate limit/i.test(rejectedBody);
            if (rateLimited) {
              const until = pauseUntil(response.headers, at);
              if (until - at <= 5000 && rateRetries < 2) {
                rateRetries++;
                yield* Effect.sleep(until - at);
                continue;
              }
              setBudget(id, resource, pause(budgetOf(id, resource), until));
              yield* Effect.logWarning("GitHub rate limited the account").pipe(
                Effect.annotateLogs({ accountId: id, resource, until: isoAt(until) }),
              );
              return yield* fail("rate-limited", usedUp(login, until), response.status, until);
            }
          }
          const failure = statusFailure(response.status, login);
          return yield* fail(
            failure.reason,
            refusal(rejectedBody) || failure.message,
            response.status,
          );
        }
      }),
    ).pipe(
      Effect.interruptible,
      Effect.timeout("30 seconds"),
      Effect.catchTags({
        AccountUnavailableError: (error) => Effect.fail(fail("unauthorized", error.message)),
        HttpClientError: (error) => {
          const oversized =
            error.reason.cause instanceof Undici.errors.ResponseExceededMaxSizeError;
          return Effect.logWarning(
            oversized ? "GitHub response exceeded its byte limit" : "GitHub transport failed",
          ).pipe(
            Effect.annotateLogs({ accountId: id, reason: oversized ? "response-size" : "network" }),
            Effect.andThen(
              Effect.fail(
                fail(
                  oversized ? "rejected" : "network",
                  oversized
                    ? "GitHub returned more data than prkit can safely read. Open the pull request on GitHub."
                    : "Couldn't reach GitHub. Check your connection and retry.",
                ),
              ),
            ),
          );
        },
        SchemaError: () =>
          Effect.fail(fail("network", "GitHub returned an unreadable response. Try refreshing.")),
        TimeoutError: () =>
          Effect.logWarning("GitHub request reached its deadline").pipe(
            Effect.annotateLogs({ accountId: id, timeoutMs: 30_000 }),
            Effect.andThen(
              Effect.fail(fail("network", "GitHub took too long to respond. Try refreshing.")),
            ),
          ),
      }),
    );
  };

  const json =
    <A>(schema: Schema.ConstraintDecoder<A>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 204
        ? Schema.decodeEffect(schema)({})
        : HttpClientResponse.schemaBodyJson(schema)(response);

  const rest = <A>(id: AccountId, path: string, schema: Schema.ConstraintDecoder<A>) =>
    exchange(
      id,
      "core",
      `GET ${path}`,
      (base) => HttpClientRequest.get(`${base}${path}`),
      json(schema),
    );
  const restWrite = <A>(
    id: AccountId,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    schema: Schema.ConstraintDecoder<A>,
    body?: GitHubJson,
  ) =>
    exchange(
      id,
      "core",
      `${method} ${path}`,
      (base) => {
        const request = HttpClientRequest.make(method)(`${base}${path}`);
        return body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body);
      },
      json(schema),
    );
  /**
   * A REST read that GitHub answers with 304 while `etag` still matches. A 304 is
   * free: it doesn't count against the account's limit.
   */
  const restChanged = (id: AccountId, path: string, etag: string | null) =>
    exchange(
      id,
      "core",
      `GET ${path}`,
      (base) =>
        HttpClientRequest.get(`${base}${path}`).pipe(
          etag === null ? (request) => request : HttpClientRequest.setHeader("if-none-match", etag),
        ),
      (
        response,
      ): Effect.Effect<
        | { readonly _tag: "unchanged" }
        | { readonly _tag: "changed"; readonly etag: string | null; readonly body: string }
      > =>
        response.status === 304
          ? Effect.succeed({ _tag: "unchanged" })
          : response.text.pipe(
              Effect.orElseSucceed(() => ""),
              Effect.map((body) => ({
                _tag: "changed" as const,
                etag: response.headers["etag"] ?? null,
                body,
              })),
            ),
    );
  const send = <A>(
    id: AccountId,
    query: string,
    variables: Readonly<Record<string, GitHubJson>>,
    schema: Schema.ConstraintDecoder<A>,
  ) => {
    const operation = operationOf(query);
    return exchange(
      id,
      "graphql",
      operation,
      (base) =>
        HttpClientRequest.post(`${base}/graphql`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ query: withCost(query), variables }),
        ),
      HttpClientResponse.schemaBodyJson(GraphQLBody),
      (body) => pointsOf(body.data?.[COST_ALIAS]),
    ).pipe(
      Effect.flatMap((body) =>
        Effect.gen(function* () {
          const errors = body.errors ?? [];
          const { [COST_ALIAS]: cost, ...rest } = body.data ?? {};
          const now = yield* Clock.currentTimeMillis;
          const budget = budgetOf(id, "graphql");
          const points = pointsOf(cost);
          setBudget(
            id,
            "graphql",
            budget === undefined ? undefined : record(budget, {}, points, now),
          );
          if (errors.some((error) => error.type === "RATE_LIMITED")) {
            const until = budget?.pausedUntil ?? Math.max(budget?.resetAt ?? 0, now + 60_000);
            setBudget(id, "graphql", pause(budget, until));
            yield* Effect.logWarning("GitHub rate limited the account").pipe(
              Effect.annotateLogs({ accountId: id, resource: "graphql", until: isoAt(until) }),
            );
            return yield* new GitHubRequestError({
              accountId: id,
              reason: "rate-limited",
              status: null,
              message: usedUp(loginOf(id), until),
              resetAt: until,
            });
          }
          if (body.data == null) return { data: null, errors };
          const read = `${id} ${query} ${encodeVariables(variables)}`;
          const decoded = yield* Schema.decodeUnknownEffect(schema)(rest).pipe(Effect.result);
          if (Result.isFailure(decoded)) {
            if (!unreadable.has(read)) {
              unreadable.add(read);
              yield* Effect.logWarning("GitHub sent an answer prkit can't read").pipe(
                Effect.annotateLogs({
                  accountId: id,
                  operation,
                  ...decodeProblem(decoded.failure),
                }),
              );
            }
            return yield* new GitHubRequestError({
              accountId: id,
              reason: "network",
              status: null,
              message: "GitHub returned an unreadable response. Try refreshing.",
            });
          }
          if (unreadable.delete(read))
            yield* Effect.logInfo("GitHub's answer reads again").pipe(
              Effect.annotateLogs({ accountId: id, operation }),
            );
          return { data: decoded.success, errors };
        }),
      ),
    );
  };
  /** Hosts whose schema has no stacks, learnt from the first query that asked for them. */
  const stackless = new Set<string>();
  /**
   * A GraphQL read whose aliases succeed or fail on their own: `data` and `errors` both
   * come back. A query built per stack support asks for stacks until the host says it
   * has none; then it is sent again without them, and so is every later one.
   */
  const graphqlResult = <A>(
    id: AccountId,
    query: GraphQLQuery,
    variables: Readonly<Record<string, GitHubJson>>,
    schema: Schema.ConstraintDecoder<A>,
  ) => {
    if (typeof query === "string") return send(id, query, variables, schema);
    const host = hostOf(id);
    if (stackless.has(host)) return send(id, query(false), variables, schema);
    return send(id, query(true), variables, schema).pipe(
      Effect.flatMap((result) => {
        if (!result.errors.some(missingStacks)) return Effect.succeed(result);
        stackless.add(host);
        return Effect.logInfo("This GitHub host has no stacks; reading it without them").pipe(
          Effect.annotateLogs({ host }),
          Effect.andThen(send(id, query(false), variables, schema)),
        );
      }),
    );
  };
  const graphql = <A>(
    id: AccountId,
    query: GraphQLQuery,
    schema: Schema.ConstraintDecoder<A>,
    variables: Readonly<Record<string, GitHubJson>> = {},
  ) =>
    graphqlResult(id, query, variables, schema).pipe(
      Effect.flatMap(({ data, errors }) =>
        data === null || errors.length > 0
          ? Effect.fail(queryFailure(id, errors))
          : Effect.succeed(data),
      ),
    );

  /** Each account's limits as GitHub last reported them, with prkit's own spend. */
  const budget = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return {
      accounts: [...budgets].map(([accountId, resources]) => ({
        accountId,
        limits: [...resources].map(([resource, value]) => toLimit(resource, value, now)),
      })),
    };
  });

  return { rest, restWrite, restChanged, graphql, graphqlResult, budget };
});

export const layer = Layer.effect(GitHubApi, make);
