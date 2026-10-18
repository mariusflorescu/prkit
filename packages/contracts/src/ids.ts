import * as Schema from "effect/Schema";

const makeEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  Schema.NonEmptyString.pipe(Schema.brand<Brand>(brand));

/** `${host}/${login}`, e.g. "github.com/octocat". */
export const AccountId = makeEntityId("AccountId");
export type AccountId = typeof AccountId.Type;
export const loginOf = (id: AccountId) => id.slice(id.indexOf("/") + 1);
/** Whether `login` is this account's own. GitHub logins ignore case. */
export const isAccountLogin = (id: AccountId, login: string | null) =>
  login !== null && loginOf(id).toLowerCase() === login.toLowerCase();

/** `${host}/${owner}/${repo}#${number}`: the stable key for tabs, reviews and caches. */
export const PullRequestKey = makeEntityId("PullRequestKey");
export type PullRequestKey = typeof PullRequestKey.Type;

export const ReviewId = makeEntityId("ReviewId");
export type ReviewId = typeof ReviewId.Type;

/** A comment prkit holds for the user until the review is finished. */
export const ReviewCommentId = makeEntityId("ReviewCommentId");
export type ReviewCommentId = typeof ReviewCommentId.Type;

/**
 * `local:<16 hex>`: the key of a review of local changes. It never reads as a pull request
 * (`refFromKey` answers null), so nothing reads it through an account.
 */
export const LocalReviewKey = Schema.String.check(Schema.isPattern(/^local:[0-9a-f]{16}$/)).pipe(
  Schema.brand("LocalReviewKey"),
);
export type LocalReviewKey = typeof LocalReviewKey.Type;

/** Any review's key, for the parts of a review that don't care what it is about. */
export const ReviewKey = Schema.Union([LocalReviewKey, PullRequestKey]);
export type ReviewKey = typeof ReviewKey.Type;

export const isLocalReviewKey = Schema.is(LocalReviewKey);
