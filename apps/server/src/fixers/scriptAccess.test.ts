import { repositoryIdOf } from "@prkit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideScripts } from "./scriptAccess.ts";

const pull = (overrides: {
  author?: string | null;
  authorAssociation?: string;
  headRepo?: string | null;
}) => ({
  author: overrides.author === undefined ? "octocat" : overrides.author,
  authorAssociation: overrides.authorAssociation ?? "OWNER",
  headRepo: overrides.headRepo === undefined ? "octocat/prkit-fixtures" : overrides.headRepo,
  repository: {
    id: repositoryIdOf("github.com", 1),
    host: "github.com",
    owner: "octocat",
    name: "prkit-fixtures",
  },
});
const ownLogins = ["octocat", "hubot"];

// A check script's command comes from the PR head's package.json, so it is the PR
// author's code running on the owner's machine.
describe("decideScripts", () => {
  it.each([
    [
      "a same-repository PR the owner opened",
      pull({}),
      { _tag: "allowed", reason: "you opened it" },
    ],
    [
      "a same-repository PR the owner opened through another of their accounts",
      pull({ author: "HuBot", authorAssociation: "CONTRIBUTOR" }),
      { _tag: "allowed", reason: "you opened it" },
    ],
    [
      "a same-repository PR by a collaborator",
      pull({ author: "alice", authorAssociation: "COLLABORATOR" }),
      {
        _tag: "allowed",
        reason: "its author, alice, is a collaborator on octocat/prkit-fixtures",
      },
    ],
    [
      "a same-repository PR by a member of the owning organization",
      pull({ author: "bob", authorAssociation: "MEMBER" }),
      { _tag: "allowed", reason: "its author, bob, is a member of octocat" },
    ],
  ])("runs scripts on %s", (_, target, expected) => {
    expect(decideScripts({ target, ownLogins, anyPullRequest: false })).toEqual(expected);
  });

  it.each([
    [
      "a PR from a fork, even the owner's own",
      pull({ headRepo: "hubot/prkit-fixtures", author: "hubot" }),
      { _tag: "blocked", reason: "it comes from a fork, hubot/prkit-fixtures" },
    ],
    [
      "a PR whose fork was deleted",
      pull({ headRepo: null }),
      { _tag: "blocked", reason: "it comes from a fork that no longer exists" },
    ],
    [
      "a same-repository PR by an author who can no longer write to it",
      pull({ author: "mallory", authorAssociation: "CONTRIBUTOR" }),
      {
        _tag: "blocked",
        reason: "its author, mallory, isn't a member or collaborator of octocat/prkit-fixtures",
      },
    ],
    [
      "a PR GitHub names no author for",
      pull({ author: null, authorAssociation: "NONE" }),
      { _tag: "blocked", reason: "GitHub doesn't say who opened it" },
    ],
  ])("runs no scripts on %s", (_, target, expected) => {
    expect(decideScripts({ target, ownLogins, anyPullRequest: false })).toEqual(expected);
  });

  it("runs scripts on a fork's PR when the repository allows every pull request", () => {
    expect(
      decideScripts({
        target: pull({
          headRepo: "someone/prkit-fixtures",
          author: "someone",
          authorAssociation: "FIRST_TIME_CONTRIBUTOR",
        }),
        ownLogins,
        anyPullRequest: true,
      }),
    ).toEqual({
      _tag: "allowed",
      reason: "you allowed it on every pull request in octocat/prkit-fixtures",
    });
  });
});
