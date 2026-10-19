import type { ReviewThreadComment } from "@prkit/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { UserAvatar } from "~/components/UserAvatar";
import { personName } from "~/features/github/personName";
import { PullRequestMarkdown } from "~/features/pullRequest/PullRequestMarkdown";
import { relativeTime } from "~/features/pullRequest/pullRequestPresentation";

export function ThreadComment({ comment }: { comment: ReviewThreadComment }) {
  const login = personName(comment.author);
  return (
    <div data-thread-comment="" className="min-w-0">
      <div className="flex items-center gap-2 text-xs">
        <UserAvatar login={login} url={comment.author?.avatarUrl ?? null} />
        <span className="font-semibold">{login}</span>
        <a
          href={comment.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground hover:underline"
          title={new Date(comment.createdAt).toLocaleString()}
        >
          <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time>
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      </div>
      <div className="mt-1.5 pl-7">
        <PullRequestMarkdown body={comment.body} />
        {comment.reactions.length > 0 && (
          <ul aria-label="Reactions" className="mt-1.5 flex flex-wrap gap-1">
            {comment.reactions.map((reaction) => (
              <li
                key={reaction.emoji}
                aria-label={`${reaction.emoji} ${reaction.count}`}
                className="rounded-full border border-border/60 px-1.5 py-0.5 text-2xs tabular-nums"
              >
                {reaction.emoji} {reaction.count}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
