import { type AccountId, type GitHubProblem, loginOf } from "@prkit/contracts";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const format = (seconds: number) => {
  const size = Math.abs(seconds);
  if (size < 3600) return relative.format(Math.trunc(seconds / 60), "minute");
  if (size < 86400) return relative.format(Math.trunc(seconds / 3600), "hour");
  return relative.format(Math.trunc(seconds / 86400), "day");
};

/** "just now", "4 minutes ago": a moment that has passed, even if the clock lags a little. */
export const ago = (iso: string, now: number) => {
  const seconds = Math.min(0, (Date.parse(iso) - now) / 1000);
  return seconds > -60 ? "just now" : format(seconds);
};

/** "in 12 minutes": a moment still ahead. */
export const until = (iso: string, now: number) => {
  const seconds = Math.max(0, (Date.parse(iso) - now) / 1000);
  return seconds < 60 ? "in less than a minute" : format(seconds);
};

export const clockTime = (iso: string) => clock.format(Date.parse(iso));

/** When a Retry may go again: never before a rate limit resets. */
export const retryAt = (problem: GitHubProblem) =>
  problem._tag === "rate-limited" ? Date.parse(problem.resetAt) : null;

/** One plain sentence or three: why this is cached, how old it is, when it can change. */
export const freshnessText = (
  problem: GitHubProblem,
  accountId: AccountId,
  fetchedAt: string | null,
  now: number,
) => {
  const age = fetchedAt === null ? "" : ` Showing what prkit fetched ${ago(fetchedAt, now)}.`;
  switch (problem._tag) {
    case "rate-limited":
      return `GitHub's limit for ${loginOf(accountId)} is used up.${age} Resets at ${clockTime(problem.resetAt)}, ${until(problem.resetAt, now)}.`;
    case "reserved":
      return `prkit is saving the rest of ${loginOf(accountId)}'s GitHub limit for your clicks.${age} Background reads resume at ${clockTime(problem.resetAt)}.`;
    case "unavailable":
    case "account":
      return `${problem.message}${age}`;
  }
};
