import { AttemptId, type ReviewStatus } from "@prkit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { observe } from "./lifecycle.ts";

// What one watcher read does to a review. A refused token and a PR that can't be read
// are hard to cause on a real machine without breaking a real login.
const HEAD = "0fb0d774fe3716d1dfb9ea6c6305de8c4e7ec09d";
const NEXT = "ab30ea7c8beec5a220e2b0f925d751574aea0d7b";
const watching: ReviewStatus = {
  _tag: "watching",
  headSha: HEAD,
  baseRef: "stack/parser",
  checkedAt: "2026-10-10T20:00:00Z",
};
const writing: ReviewStatus = { _tag: "writing", attemptId: AttemptId.make("a1"), revision: 2 };
const failed: ReviewStatus = { _tag: "failed", reason: "agent", message: "x", attemptId: null };
const refused = { _tag: "refused", message: "GitHub refused octocat's token." } as const;

describe("observe", () => {
  it("fails the account of a watching review whose token GitHub refused", () => {
    expect(observe(watching, refused)).toEqual({ _tag: "fail-account", message: refused.message });
  });

  it("only notes a refused token on a review that is writing; its attempt decides", () => {
    expect(observe(writing, refused)).toEqual({ _tag: "problem", message: refused.message });
  });

  it("notes a PR it can't read and leaves the review as it is", () => {
    expect(observe(watching, { _tag: "unreadable", message: "rate limited" })).toEqual({
      _tag: "problem",
      message: "rate limited",
    });
  });

  it("ends a review that is writing when its PR is merged", () => {
    expect(
      observe(writing, { _tag: "pull", state: "merged", headSha: NEXT, baseRef: "main" }),
    ).toEqual({
      _tag: "end",
      reason: "merged",
    });
  });

  it("waits for Retry on a failed review whose PR got new commits", () => {
    expect(
      observe(failed, { _tag: "pull", state: "open", headSha: NEXT, baseRef: "main" }),
    ).toEqual({
      _tag: "checked",
    });
  });

  it("updates a watching guide when the layer below merged and the PR now targets main", () => {
    expect(
      observe(watching, { _tag: "pull", state: "open", headSha: HEAD, baseRef: "main" }),
    ).toEqual({ _tag: "update", headSha: HEAD });
  });

  it("never touches a done review", () => {
    const done: ReviewStatus = { _tag: "done", reason: "stopped" };
    expect(
      observe(done, { _tag: "pull", state: "closed", headSha: NEXT, baseRef: "main" }),
    ).toEqual({
      _tag: "none",
    });
  });
});
