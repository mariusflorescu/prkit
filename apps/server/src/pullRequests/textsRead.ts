import {
  type AccountId,
  DIFF_TEXT_MAX_BYTES,
  type DiffTexts,
  type FileText,
  type PullRequestRef,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { GitHubApi, graphQLFailure, inBackground, queryFailure } from "../github/GitHubApi.ts";

/** A blob's fields; a path that is a folder or a submodule answers `{}`, as the fragment doesn't match. */
const Blob = Schema.NullOr(
  Schema.Struct({
    text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    isTruncated: Schema.optionalKey(Schema.Boolean),
    isBinary: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    byteSize: Schema.optionalKey(Schema.Int),
  }),
);
const TextsResponse = Schema.Struct({
  repository: Schema.NullOr(Schema.Record(Schema.String, Blob)),
});

const binary: FileText = { _tag: "unreadable", reason: "binary" };

const textOf = (blob: typeof Blob.Type): FileText => {
  if (blob == null || blob.byteSize === undefined) return { _tag: "unreadable", reason: "missing" };
  if (blob.isBinary === true) return binary;
  if (blob.isTruncated === true || blob.byteSize > DIFF_TEXT_MAX_BYTES)
    return { _tag: "unreadable", reason: "too-large" };
  if (blob.text == null || blob.text.includes("\0")) return binary;
  return { _tag: "text", content: blob.text };
};

/**
 * One aliased blob per path (`f0`, `f1`, ...); owner, name and every `<sha>:<path>`
 * expression travel as variables. A fork's head resolves through the base repository.
 */
const textsQuery = (ref: PullRequestRef, sha: string, paths: ReadonlyArray<string>) => {
  const variables: Record<string, string> = { owner: ref.owner, name: ref.repo };
  const declarations = ["$owner: String!", "$name: String!"];
  const fields = paths.map((path, index) => {
    variables[`e${index}`] = `${sha}:${path}`;
    declarations.push(`$e${index}: String!`);
    return `    f${index}: object(expression: $e${index}) { ... on Blob { text isTruncated isBinary byteSize } }`;
  });
  return {
    query: `query PrkitTexts(${declarations.join(", ")}) {\n  repository(owner: $owner, name: $name) {\n${fields.join("\n")}\n  }\n}`,
    variables,
  };
};

/**
 * The text of each path at a commit of the PR, in one GraphQL request through the account
 * that found it. A path GitHub can't show, or answers as not found, is `missing`.
 */
export const makeTextsRead = Effect.gen(function* () {
  const api = yield* GitHubApi;
  return (accountId: AccountId, ref: PullRequestRef, sha: string, paths: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const { query, variables } = textsQuery(ref, sha, paths);
      const { data, errors } = yield* inBackground(
        api.graphqlResult(accountId, query, variables, TextsResponse),
      );
      // A path GitHub won't show comes back as a null alias with a not-found error under
      // `repository.fN`; any other error means the read isn't to be trusted, or cached.
      const failures = errors.filter(
        (error) => error.path?.length !== 2 || graphQLFailure(error) !== "not-found",
      );
      if (data === null || data.repository === null || failures.length > 0)
        return yield* queryFailure(accountId, failures.length > 0 ? failures : errors);
      const { repository } = data;
      return {
        files: paths.map((path, index) => ({
          path,
          text: textOf(repository[`f${index}`] ?? null),
        })),
      } satisfies DiffTexts;
    });
});
