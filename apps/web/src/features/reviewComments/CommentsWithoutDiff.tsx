import type { AccountId, DiffFile, PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { pendingCommentsQuery } from "~/rpc/queries";
import { NewCommentComposer } from "./NewCommentComposer";
import { PendingCommentCard } from "./PendingCommentCard";
import { composerForm, useComposers } from "./reviewCommentsStore";

const noDiff = { _tag: "outdated", why: "file", suggestion: null } as const;

/**
 * Drafts, and comments being written, on files GitHub shows no text diff for now, such as
 * a file a push took out of the pull request. They have no file card to wait under.
 */
export function CommentsWithoutDiff({
  pr,
  files,
}: {
  pr: { key: PullRequestKey; accountId: AccountId };
  files: ReadonlyArray<DiffFile>;
}) {
  const pending = useQuery(pendingCommentsQuery(pr.key, pr.accountId));
  const composers = useComposers(pr);
  const shown = new Set(
    files.filter((file) => file.patch._tag === "text").map((file) => file.path),
  );
  const drafts = (pending.data?.comments ?? []).filter(
    (comment) => comment.state === "draft" && !shown.has(comment.anchor.path),
  );
  const writing = composers.filter(
    (composer) => composer.site.on === "files" && !shown.has(composer.placement.anchor.path),
  );
  const paths = new Set([
    ...writing.map((composer) => composer.placement.anchor.path),
    ...drafts.map((comment) => comment.anchor.path),
  ]);
  if (paths.size === 0) return null;
  return (
    <section
      aria-label="Comments on files without a diff"
      className="border-b border-border/60 py-1"
    >
      {[...paths].map((path) => (
        <div key={path} role="group" aria-label={`Comments on ${path}`}>
          <p className="truncate px-4 pt-2 font-mono text-2xs text-muted-foreground" title={path}>
            {path}
          </p>
          {writing
            .filter((composer) => composer.placement.anchor.path === path)
            .map((composer) => (
              <NewCommentComposer
                key={composerForm(composer)}
                pr={pr}
                composer={composer}
                placed={noDiff}
              />
            ))}
          {drafts
            .filter((comment) => comment.anchor.path === path)
            .map((comment) => (
              <PendingCommentCard key={comment.id} comment={comment} pr={pr} placed={noDiff} />
            ))}
        </div>
      ))}
    </section>
  );
}
