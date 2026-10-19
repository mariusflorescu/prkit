import { isLocalReviewKey, type ReviewKey } from "@prkit/contracts";

/**
 * What a guide explains: a pull request, or the changes in a local folder before one exists.
 * Each is also the tag of the scope that asks about all of it.
 */
export type Subject = "pull-request" | "local-changes";

export const subjectOf = (key: ReviewKey): Subject =>
  isLocalReviewKey(key) ? "local-changes" : "pull-request";

interface SubjectWords {
  /** The numbered diff in the question's folder, named as the guide's own attempt named it. */
  readonly diffFile: string;
  /** Follows the prompt's first line. */
  readonly note: string;
  readonly whole: string;
  /** What a fresh conversation's working directory is. */
  readonly checkout: string;
  /** Why the other subject's whole-subject scope is refused. */
  readonly otherWhole: string;
}

/** Everything that reads differently by subject, so the rest of asking never branches on it. */
export const SUBJECTS = {
  "pull-request": {
    diffFile: "pull-request.diff",
    note: "",
    whole: "The question is about the whole pull request.",
    checkout: "a read-only checkout of the pull request at that head",
    otherWhole:
      "This guide is of a pull request, not local changes. Ask about the whole pull request, a chapter or some lines.",
  },
  "local-changes": {
    diffFile: "changes.diff",
    note: " These changes aren't a pull request yet.",
    whole: "The question is about all of these local changes.",
    checkout: "a read-only checkout of the snapshot prkit took of these local changes",
    otherWhole:
      "This guide is of local changes, not a pull request. Ask about all the changes, a chapter or some lines.",
  },
} satisfies Record<Subject, SubjectWords>;
