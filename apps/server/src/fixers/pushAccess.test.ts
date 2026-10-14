import { describe, expect, it } from "vite-plus/test";

import { pushAccessOf, type PushRead } from "./pushAccess.ts";

const read = (
  overrides: {
    viewerPermission?: string | null;
    headPermission?: string | null;
    cross?: boolean;
    maintainerCanModify?: boolean;
    archived?: boolean;
    head?: null;
    state?: "OPEN" | "CLOSED" | "MERGED";
  } = {},
): PushRead => ({
  viewer: { login: "hubot" },
  repository: {
    viewerPermission: overrides.viewerPermission ?? "READ",
    pullRequest: {
      state: overrides.state ?? "OPEN",
      headRefName: "fix/limits",
      isCrossRepository: overrides.cross ?? false,
      maintainerCanModify: overrides.maintainerCanModify ?? false,
      headRepository:
        overrides.head === null
          ? null
          : {
              nameWithOwner: overrides.cross ? "someone/prkit-fixtures" : "octocat/prkit-fixtures",
              isArchived: overrides.archived ?? false,
              viewerPermission: overrides.headPermission ?? "READ",
            },
    },
  },
});

// Push is offered only where GitHub would take it; every other case names why.
describe("pushAccessOf", () => {
  it("allows the branch's own writers", () => {
    expect(pushAccessOf(read({ headPermission: "WRITE" }))).toEqual({
      _tag: "allowed",
      repository: "octocat/prkit-fixtures",
      branch: "fix/limits",
    });
  });

  it("allows a maintainer on a fork whose author lets maintainers push", () => {
    expect(
      pushAccessOf(read({ cross: true, viewerPermission: "MAINTAIN", maintainerCanModify: true })),
    ).toEqual({ _tag: "allowed", repository: "someone/prkit-fixtures", branch: "fix/limits" });
  });

  it.each([
    [
      "a reader of someone else's repository",
      read(),
      "hubot can't push to octocat/prkit-fixtures.",
    ],
    [
      "a maintainer on a fork that doesn't allow edits",
      read({ cross: true, viewerPermission: "ADMIN" }),
      "This pull request comes from someone/prkit-fixtures, and its author doesn't allow maintainers to push to it.",
    ],
    [
      "a reader on a fork that allows edits",
      read({ cross: true, maintainerCanModify: true }),
      "hubot can't push to someone/prkit-fixtures.",
    ],
    [
      "an archived repository",
      read({ headPermission: "ADMIN", archived: true }),
      "octocat/prkit-fixtures is archived, so nothing can be pushed.",
    ],
    [
      "a deleted head repository",
      read({ head: null }),
      "The pull request's branch is gone: its repository was deleted.",
    ],
    [
      "a merged pull request",
      read({ headPermission: "WRITE", state: "MERGED" }),
      "This pull request isn't open.",
    ],
  ])("refuses %s", (_, input, reason) => {
    expect(pushAccessOf(input)).toEqual({ _tag: "denied", reason });
  });
});
