import type { InboxEntry } from "@prkit/contracts";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";

const presentation = {
  open: { Icon: GitPullRequestIcon, label: "Open", tone: "text-success-foreground" },
  draft: { Icon: GitPullRequestDraftIcon, label: "Draft", tone: "text-muted-foreground" },
  merged: { Icon: GitMergeIcon, label: "Merged", tone: "text-info-foreground" },
  closed: { Icon: GitPullRequestClosedIcon, label: "Closed", tone: "text-error-foreground" },
};

/**
 * The one map from a pull request's state to its icon, label and color: tab icons, inbox rows
 * and the PR header all read it. Merged and closed outrank draft, which only means something
 * while the PR is open.
 */
export const pullRequestState = ({ state, isDraft }: Pick<InboxEntry, "state" | "isDraft">) =>
  presentation[state === "open" ? (isDraft ? "draft" : "open") : state];
