import { describe, expect, it } from "vite-plus/test";

import { AccountId, PullRequestKey } from "../src/ids.ts";
import type { PullRequestDetail } from "../src/pullRequest.ts";
import {
  primaryPullRequestAction,
  pullRequestActionReason,
  pullRequestMenuActions,
} from "../src/pullRequestActionPolicy.ts";

const ALLOWED = {
  update: true,
  merge: true,
  triage: true,
  updateBranch: false,
  close: true,
  reopen: false,
  labels: true,
  reviewers: true,
  enableAutoMerge: false,
  disableAutoMerge: false,
};

/** An open, mergeable PR in acme/widgets that the account can write to; `change` sets the rest. */
const pull = (
  change: {
    readonly state?: PullRequestDetail["state"];
    readonly isDraft?: boolean;
    readonly mergeability?: PullRequestDetail["mergeability"];
    readonly reviewDecision?: PullRequestDetail["reviewDecision"];
    readonly actions?: Partial<Omit<PullRequestDetail["actions"], "viewerPermissions">>;
    readonly can?: Partial<PullRequestDetail["actions"]["viewerPermissions"]>;
  } = {},
): PullRequestDetail => ({
  key: PullRequestKey.make("github.com/acme/widgets#7"),
  accountId: AccountId.make("github.com/octocat"),
  ref: { host: "github.com", owner: "acme", repo: "widgets", number: 7 },
  title: "Count clicks",
  body: "",
  state: change.state ?? "open",
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  isDraft: change.isDraft ?? false,
  author: { login: "octocat", avatarUrl: null },
  headBranch: "count-clicks",
  baseBranch: "main",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  mergeability: change.mergeability ?? "mergeable",
  reviewDecision: change.reviewDecision ?? null,
  reviewers: [],
  checks: [],
  labels: [],
  conversation: [],
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  url: "https://github.com/acme/widgets/pull/7",
  actions: {
    nodeId: "PR_7",
    mergeState: "CLEAN",
    behindBy: 0,
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    preferredMergeMethod: "merge",
    checksState: "passing",
    autoMergeAllowed: false,
    autoMergeMethod: null,
    mergeQueue: false,
    isFork: false,
    canDeleteBranch: true,
    mergeMessages: { merge: { title: "", body: "" }, squash: { title: "", body: "" } },
    preferences: { mergeMethod: null, deleteBranch: false },
    ...change.actions,
    viewerPermissions: { ...ALLOWED, ...change.can },
  },
  stack: null,
  freshness: { fetchedAt: "2026-10-02T10:00:00Z", problem: null },
});

const header = (detail: PullRequestDetail) => ({
  primary: primaryPullRequestAction(detail),
  menu: pullRequestMenuActions(detail),
});

describe("the header's actions", () => {
  it("offers a mergeable PR Merge, and only the lifecycle actions in the menu", () => {
    expect(header(pull())).toEqual({ primary: "merge", menu: [["draft", "close"]] });
  });

  it("keeps Merge in the menu, enabled, when a behind branch makes Update branch primary", () => {
    const behind = pull({ actions: { behindBy: 3 }, can: { updateBranch: true } });
    expect(header(behind)).toEqual({
      primary: "update-branch",
      menu: [["merge"], ["draft", "close"]],
    });
    expect(pullRequestActionReason(behind, "merge")).toBeNull();
  });

  it("keeps Merge blocked by checks in the menu, with its reason", () => {
    const blocked = pull({
      actions: { behindBy: 3, mergeState: "BLOCKED" },
      can: { updateBranch: true },
    });
    expect(header(blocked).menu[0]).toEqual(["merge"]);
    expect(pullRequestActionReason(blocked, "merge")).toBe(
      "GitHub requires checks, approvals or an updated branch before merging.",
    );
  });

  it("offers auto-merge only where the repository allows it", () => {
    const required = { mergeState: "BLOCKED" } as const;
    expect(header(pull({ actions: required, can: { enableAutoMerge: true } }))).toEqual({
      primary: "merge",
      menu: [["draft", "close"]],
    });
    const allowed = pull({
      actions: { ...required, autoMergeAllowed: true },
      can: { enableAutoMerge: true },
    });
    expect(header(allowed)).toEqual({
      primary: "enable-auto-merge",
      menu: [["merge"], ["draft", "close"]],
    });
    const behind = pull({
      actions: { autoMergeAllowed: true, behindBy: 1 },
      can: { enableAutoMerge: true, updateBranch: true },
    });
    expect(header(behind).menu[0]).toEqual(["merge", "enable-auto-merge"]);
  });

  it("offers Disable auto-merge alone once it is on, never both", () => {
    const on = pull({
      actions: { autoMergeAllowed: true, autoMergeMethod: "squash", behindBy: 2 },
      can: { disableAutoMerge: true, enableAutoMerge: true, updateBranch: true },
    });
    expect(header(on)).toEqual({
      primary: "update-branch",
      menu: [
        ["merge", "disable-auto-merge"],
        ["draft", "close"],
      ],
    });
  });

  it("drops Merge for a merge queue, which auto-merge joins", () => {
    const queue = pull({ actions: { mergeQueue: true }, can: { enableAutoMerge: true } });
    expect(header(queue)).toEqual({ primary: "enable-auto-merge", menu: [["draft", "close"]] });
  });

  it("offers Approve workflows on a fork's PR only", () => {
    expect(header(pull({ actions: { isFork: true } })).menu[0]).toEqual(["approve-workflows"]);
    expect(header(pull()).menu.flat()).not.toContain("approve-workflows");
  });

  it("leaves merging out of a draft until it is ready for review", () => {
    const draft = pull({ isDraft: true, actions: { behindBy: 1 }, can: { updateBranch: true } });
    expect(header(draft)).toEqual({ primary: "ready", menu: [["update-branch"], ["close"]] });
  });

  it("leaves Update branch for a conflicting PR to the resolution", () => {
    const conflicting = pull({
      mergeability: "conflicting",
      actions: { behindBy: 4 },
      can: { updateBranch: true },
    });
    expect(header(conflicting)).toEqual({
      primary: "resolve-conflicts",
      menu: [["merge"], ["draft", "close"]],
    });
  });

  it("offers Resolve conflicts on a conflicting draft, with Ready for review in the menu", () => {
    const draft = pull({ isDraft: true, mergeability: "conflicting" });
    expect(header(draft)).toEqual({ primary: "resolve-conflicts", menu: [["ready", "close"]] });
    const locked = pull({ isDraft: true, mergeability: "conflicting", can: { update: false } });
    expect(header(locked)).toEqual({ primary: "resolve-conflicts", menu: [["close"]] });
  });

  it("has no menu for a merged or closed PR", () => {
    expect(header(pull({ state: "merged" }))).toEqual({ primary: "revert", menu: [] });
    expect(header(pull({ state: "closed", can: { reopen: true } }))).toEqual({
      primary: "reopen",
      menu: [],
    });
  });

  it("offers no primary the account may never take", () => {
    const reader = pull({ can: { update: false, merge: false, close: false } });
    expect(header(reader)).toEqual({ primary: null, menu: [] });
    expect(header(pull({ state: "merged", can: { merge: false } }))).toEqual({
      primary: null,
      menu: [],
    });
    expect(header(pull({ state: "closed" }))).toEqual({ primary: null, menu: [] });
    expect(header(pull({ isDraft: true, can: { update: false } }))).toEqual({
      primary: null,
      menu: [["close"]],
    });
  });

  it("falls back to Merge, blocked, when the account can't update a behind branch", () => {
    const behind = pull({ actions: { behindBy: 2, mergeState: "BEHIND" } });
    expect(header(behind)).toEqual({ primary: "merge", menu: [["draft", "close"]] });
    expect(pullRequestActionReason(behind, "merge")).toBe(
      "GitHub requires checks, approvals or an updated branch before merging.",
    );
  });

  it("never lists the primary action or page actions in the menu", () => {
    const details = [
      pull(),
      pull({ isDraft: true }),
      pull({ actions: { behindBy: 2 }, can: { updateBranch: true } }),
      pull({ actions: { isFork: true, mergeState: "BLOCKED", autoMergeAllowed: true } }),
      pull({ mergeability: "conflicting" }),
      pull({ isDraft: true, mergeability: "conflicting" }),
      pull({ can: { merge: false, update: false } }),
      pull({ state: "merged" }),
      pull({ state: "closed", can: { reopen: true } }),
    ];
    for (const detail of details) {
      const { primary, menu } = header(detail);
      const listed = menu.flat();
      expect(listed).not.toContain(primary);
      expect(new Set(listed).size).toBe(listed.length);
      for (const page of ["edit", "labels", "reviewers"]) expect(listed).not.toContain(page);
    }
  });
});
