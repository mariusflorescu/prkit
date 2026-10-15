import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { wrote } from "./model.ts";

const Request = Schema.Struct({
  query: Schema.String,
  operationName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const Body = Schema.fromJsonString(Schema.Json);

/** Classify document operations, ignoring strings, comments and nested field names. */
const operationKind = (text: string) => {
  const query = text.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\r\n]*/g, " ");
  if (/[^\w\s!$():=@[\]{}.,+\-\uFEFF]/.test(query)) return "unclassified";
  const stack: string[] = [];
  let definition: "query" | "mutation" | "subscription" | "fragment" | null = null;
  let queries = 0;
  let mutations = 0;
  let subscriptions = 0;
  for (const token of query.match(/[_A-Za-z][_0-9A-Za-z]*|[^\s,\uFEFF]/g) ?? []) {
    if (token === "{" || token === "(" || token === "[") {
      if (stack.length === 0 && token === "{") {
        definition ??= "query";
        if (definition === "query") queries++;
        else if (definition === "mutation") mutations++;
        else if (definition === "subscription") subscriptions++;
      } else if (definition === null) return "unclassified";
      stack.push(token);
    } else if (token === "}" || token === ")" || token === "]") {
      const open = stack.pop();
      if (open !== (token === "}" ? "{" : token === ")" ? "(" : "[")) return "unclassified";
      if (stack.length === 0 && token === "}") definition = null;
    } else if (stack.length === 0 && definition === null) {
      if (
        token === "query" ||
        token === "mutation" ||
        token === "subscription" ||
        token === "fragment"
      )
        definition = token;
      else return "unclassified";
    }
  }
  if (stack.length !== 0 || definition !== null || subscriptions > 0) return "unclassified";
  if (mutations > 0) return "mutation";
  return queries > 0 ? "query" : "unclassified";
};

export const recordGraphqlAttempt = (body: string) => {
  const parsed = Schema.decodeOption(Body)(body);
  if (Option.isNone(parsed)) return wrote("graphql unclassified", body);
  const requests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  if (requests.length === 0) return wrote("graphql unclassified", parsed.value);
  for (const input of requests) {
    const request = Schema.decodeUnknownOption(Request)(input);
    if (Option.isNone(request)) {
      wrote("graphql unclassified", input);
      continue;
    }
    const kind = operationKind(request.value.query);
    if (kind === "query") continue;
    wrote(
      kind === "unclassified"
        ? "graphql unclassified"
        : request.value.query.includes("enablePullRequestAutoMerge")
          ? "enablePullRequestAutoMerge"
          : request.value.query.includes("disablePullRequestAutoMerge")
            ? "disablePullRequestAutoMerge"
            : "graphql mutation",
      request.value.variables ?? {},
    );
  }
};
export const recordRestAttempt = (method: string, path: string, body: string) => {
  if (method === "GET") return;
  const parsed = Schema.decodeOption(Body)(body);
  wrote(
    `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+\//, "")}`,
    Option.isSome(parsed) ? parsed.value : body === "" ? {} : body,
  );
};
