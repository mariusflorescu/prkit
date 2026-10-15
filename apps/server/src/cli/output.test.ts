import { expect, it } from "vite-plus/test";

import { continuationOutput, humanOutput } from "./output.ts";

it("preserves command arguments and shell-quotes the server's next-page cursor", () => {
  const cursor = "opaque ' page $(touch nope)";
  expect(
    continuationOutput({ items: [], nextCursor: cursor }, [
      "pr",
      "files",
      "acme/widgets#42",
      "--account",
      "github.com/octocat",
      "--limit",
      "2",
      "--cursor",
      "old",
      "--response-cursor=old-fragment",
    ]),
  ).toBe(
    "Next page:\nprkit pr files 'acme/widgets#42' --account github.com/octocat --limit 2 --cursor 'opaque '\\'' page $(touch nope)'",
  );
});

it("continues a response fragment at the same page without changing its text", () => {
  const fragment = {
    _tag: "response-fragment",
    text: '{"items":[',
    offset: 0,
    totalCharacters: 100,
    nextResponseCursor: "next",
    truncated: true,
  };
  expect(humanOutput(fragment)).toContain('text: {"items":[');
  expect(
    continuationOutput(fragment, [
      "repos",
      "list",
      "--cursor=page",
      "--response-cursor",
      "old",
      "--limit",
      "1",
    ]),
  ).toBe(
    "Continue this response using the server's cursor. Join text fragments in offset order before decoding the complete JSON.\nprkit repos list --cursor=page --limit 1 --response-cursor next",
  );
  expect(continuationOutput({ ...fragment, nextResponseCursor: null }, [])).toContain(
    "Final response fragment.",
  );
  expect(continuationOutput({ nextCursor: null }, [])).toBe("");
});

it.each([false, true])(
  "inserts a continuation before -- and preserves every positional word (fragment: %s)",
  (fragment) => {
    const result = fragment
      ? { _tag: "response-fragment", nextResponseCursor: "next ' cursor" }
      : { nextCursor: "next ' cursor" };
    const output = continuationOutput(result, [
      "pr",
      "files",
      "--cursor=page",
      "--response-cursor",
      "old",
      "--",
      "acme/widgets#42",
      "--cursor",
      "literal",
      "--response-cursor=literal",
    ]);
    expect(output.split("\n").at(-1)).toBe(
      `prkit pr files${fragment ? " --cursor=page" : ""} ${fragment ? "--response-cursor" : "--cursor"} 'next '\\'' cursor' -- 'acme/widgets#42' --cursor literal --response-cursor=literal`,
    );
  },
);
