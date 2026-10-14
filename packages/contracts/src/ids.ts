import * as Schema from "effect/Schema";

const makeEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  Schema.NonEmptyString.pipe(Schema.brand<Brand>(brand));

/** `${host}/${login}`, e.g. "github.com/octocat". */
export const AccountId = makeEntityId("AccountId");
export type AccountId = typeof AccountId.Type;

/** `${host}/${owner}/${repo}#${number}`: the stable key for tabs, reviews and caches. */
export const PullRequestKey = makeEntityId("PullRequestKey");
export type PullRequestKey = typeof PullRequestKey.Type;

export const ReviewId = makeEntityId("ReviewId");
export type ReviewId = typeof ReviewId.Type;

/** A comment prkit holds for the user until the review is finished. */
export const ReviewCommentId = makeEntityId("ReviewCommentId");
export type ReviewCommentId = typeof ReviewCommentId.Type;
