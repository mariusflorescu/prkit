import { describe, expect, it } from "vite-plus/test";

import { fetchFailure } from "./fetchFailure.ts";

const context = {
  login: "octocat",
  repo: "acme/monorepo",
  refspec: "+refs/heads/feature:refs/prkit/pulls/7/base",
};

describe("fetchFailure", () => {
  it("says GitHub left files out when the pack needs a blob the cache lacks", () => {
    const stderr = [
      "warning: lazy fetching disabled; some objects may not be available",
      "fatal: could not fetch 5d1c2f0e9a7b3c4d8e6f1a2b3c4d5e6f7a8b9c0d from promisor remote",
      "fatal: index-pack failed",
    ].join("\n");
    expect(fetchFailure(stderr, context)).toEqual({
      reason: "repository",
      message:
        "GitHub sent acme/monorepo without some of the files prkit asked for. Retry, and if it happens again, prkit's log has git's error.",
    });
  });

  it("says GitHub left files out when the pack lacks a blob prkit asked for", () => {
    const stderr = [
      "fatal: bad revision 'e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5'",
      "error: failed to close rev-list's stdin: Broken pipe",
      "error: https://github.com/acme/monorepo.git did not send all necessary objects",
    ].join("\n");
    expect(fetchFailure(stderr, context).message).toBe(
      "GitHub sent acme/monorepo without some of the files prkit asked for. Retry, and if it happens again, prkit's log has git's error.",
    );
  });

  it("blames the account when GitHub refuses the token", () => {
    const stderr =
      "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/monorepo.git/'";
    expect(fetchFailure(stderr, context)).toEqual({
      reason: "account",
      message:
        "GitHub refused octocat's token while fetching acme/monorepo. Refresh the account in Settings, then retry.",
    });
  });

  it("names the branch GitHub no longer has", () => {
    const stderr = "fatal: couldn't find remote ref refs/heads/feature";
    expect(fetchFailure(stderr, context).message).toBe(
      "GitHub no longer has a branch this pull request needs (+refs/heads/feature:refs/prkit/pulls/7/base). Retry once the pull request is updated.",
    );
  });

  it("points at the connection when git couldn't reach GitHub", () => {
    const stderr =
      "fatal: unable to access 'https://github.com/acme/monorepo.git/': Could not resolve host: github.com";
    expect(fetchFailure(stderr, context)).toEqual({
      reason: "repository",
      message: "Couldn't fetch acme/monorepo from GitHub. Check your connection, then retry.",
    });
  });
});
