import type { GitHubLimit, GitHubResource } from "@prkit/contracts";
import * as DateTime from "effect/DateTime";

/** A click is `interactive`; revalidation, fingerprints, watcher ticks and auto guides are `background`. */
export type Priority = "interactive" | "background";

/** One account's view of one resource: GitHub's last headers, a pause, and prkit's own spend. */
export interface ResourceBudget {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly pausedUntil: number | null;
  readonly spent: ReadonlyArray<{ readonly at: number; readonly cost: number }>;
}

export type Admission =
  | { readonly _tag: "go" }
  /** GitHub refused this account; nothing is sent until `until`. */
  | { readonly _tag: "paused"; readonly until: number }
  /** Under 10% left: background reads wait for the reset, clicks still go. */
  | { readonly _tag: "reserved"; readonly until: number };

const RESERVE = 0.1;
const HOUR = 3_600_000;
/** A rate limit answer with neither Retry-After nor a reset time. */
const FALLBACK_PAUSE = 60_000;

export const admit = (
  budget: ResourceBudget | undefined,
  priority: Priority,
  now: number,
): Admission => {
  if (budget === undefined) return { _tag: "go" };
  if (budget.pausedUntil !== null && now < budget.pausedUntil)
    return { _tag: "paused", until: budget.pausedUntil };
  if (
    priority === "background" &&
    now < budget.resetAt &&
    budget.remaining < budget.limit * RESERVE
  )
    return { _tag: "reserved", until: budget.resetAt };
  return { _tag: "go" };
};

type Headers = Readonly<Record<string, string | undefined>>;

const header = (headers: Headers, name: string) => {
  const value = Number(headers[name]);
  return headers[name] === undefined || !Number.isFinite(value) ? null : value;
};

/**
 * Records one response. `cost` is what this request spent (GraphQL's own figure, or one
 * REST request); a response that says nothing is left pauses until the reset.
 */
export const record = (
  budget: ResourceBudget | undefined,
  headers: Headers,
  cost: number,
  now: number,
): ResourceBudget | undefined => {
  const limit = header(headers, "x-ratelimit-limit");
  const remaining = header(headers, "x-ratelimit-remaining");
  const reset = header(headers, "x-ratelimit-reset");
  const spent = (budget?.spent ?? []).filter((entry) => entry.at > now - HOUR);
  if (cost > 0) spent.push({ at: now, cost });
  if (limit === null || remaining === null || reset === null)
    return budget === undefined ? undefined : { ...budget, spent };
  const resetAt = reset * 1000;
  const paused = budget?.pausedUntil ?? null;
  return {
    limit,
    remaining,
    resetAt,
    pausedUntil: remaining === 0 ? resetAt : paused !== null && paused > now ? paused : null,
    spent,
  };
};

/** When GitHub will take requests again after refusing one for its rate limit. */
export const pauseUntil = (headers: Headers, now: number) => {
  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(now, at);
  }
  const reset = header(headers, "x-ratelimit-reset");
  return reset === null ? now + FALLBACK_PAUSE : Math.max(now, reset * 1000);
};

export const pause = (budget: ResourceBudget | undefined, until: number): ResourceBudget => ({
  limit: budget?.limit ?? 0,
  remaining: budget?.remaining ?? 0,
  resetAt: budget?.resetAt ?? until,
  pausedUntil: until,
  spent: budget?.spent ?? [],
});

export const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const toLimit = (
  resource: GitHubResource,
  budget: ResourceBudget,
  now: number,
): GitHubLimit => ({
  resource,
  limit: budget.limit,
  remaining: budget.remaining,
  resetAt: isoAt(budget.resetAt),
  pausedUntil:
    budget.pausedUntil !== null && budget.pausedUntil > now ? isoAt(budget.pausedUntil) : null,
  spentLastHour: budget.spent
    .filter((entry) => entry.at > now - HOUR)
    .reduce((sum, entry) => sum + entry.cost, 0),
});
