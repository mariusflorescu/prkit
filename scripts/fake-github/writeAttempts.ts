import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { wrote } from "./model.ts";

const Request = Schema.fromJsonString(
  Schema.Struct({ query: Schema.String, variables: Schema.optionalKey(Schema.Json) }),
);
const Body = Schema.fromJsonString(Schema.Json);
export const recordGraphqlAttempt = (body: string) => {
  const request = Schema.decodeOption(Request)(body);
  if (Option.isNone(request)) return;
  // Strip GraphQL strings and comments before looking for the operation keyword.
  const query = request.value.query.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, " ");
  if (/\bmutation\b/.test(query))
    wrote(
      query.includes("enablePullRequestAutoMerge")
        ? "enablePullRequestAutoMerge"
        : query.includes("disablePullRequestAutoMerge")
          ? "disablePullRequestAutoMerge"
          : "graphql mutation",
      request.value.variables ?? {},
    );
};
export const recordRestAttempt = (method: string, path: string, body: string) => {
  if (method === "GET") return;
  const parsed = Schema.decodeOption(Body)(body);
  wrote(
    `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+\//, "")}`,
    Option.isSome(parsed) ? parsed.value : body === "" ? {} : body,
  );
};
