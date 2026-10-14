import type { AccountId, PullRequestKey, ReviewThread } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { SendToAgentButton } from "~/features/fixes/SendToAgentButton";
import { replyToThread, resolveThread } from "~/rpc/client";
import { CommentCard } from "./CommentCard";
import { CommentForm } from "./CommentForm";
import { DiffSnippet } from "./DiffSnippet";
import { ThreadComment } from "./ThreadComment";
import { storeThreads } from "./reviewCommentsCache";
import { hunkTail, rangeLabel } from "./reviewCommentPresentation";

/**
 * A GitHub review thread. Replies and resolving go to GitHub at once through the
 * PR's account. A resolved thread starts folded to one line.
 */
export function ReviewThreadCard({
  thread,
  pr,
  context = false,
  inset = true,
}: {
  thread: ReviewThread;
  pr: { key: PullRequestKey; accountId: AccountId };
  /** Show the file and lines it is on, for places outside the diff. */
  context?: boolean;
  inset?: boolean;
}) {
  const client = useQueryClient();
  const store = storeThreads(client, pr.key, pr.accountId);
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const reply = useMutation({
    mutationFn: (body: string) => replyToThread({ ...pr, threadId: thread.id, body }),
    onSuccess: (threads) => {
      store(threads);
      setReplying(false);
    },
  });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => resolveThread({ ...pr, threadId: thread.id, resolved }),
    onSuccess: (threads, resolved) => {
      store(threads);
      setOpen(!resolved);
    },
  });
  const where = thread.anchor
    ? rangeLabel(thread.anchor)
    : `line ${thread.originalLine ?? "?"} (outdated)`;
  const author = thread.comments[0]?.author?.login ?? "ghost";
  const count = thread.commentCount;
  return (
    <CommentCard inset={inset} label={`Thread by ${author} on ${thread.path} ${where}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {thread.resolved ? (
          <CircleCheckIcon aria-hidden className="size-3.5 text-success-foreground" />
        ) : (
          <MessageSquareIcon aria-hidden className="size-3.5" />
        )}
        <button
          type="button"
          aria-expanded={open}
          className="hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {thread.resolved ? "Resolved" : "Open"} · {count} {count === 1 ? "comment" : "comments"}
          {!open && ` · ${author}`}
        </button>
        {thread.anchor === null && (
          <span className="rounded border border-border/60 px-1 text-3xs">Outdated</span>
        )}
        {!thread.resolved && (
          <span className="ml-auto">
            <SendToAgentButton
              pr={pr}
              target={{ _tag: "thread", threadId: thread.id }}
              label={`the thread by ${author} on ${thread.path} ${where}`}
            />
          </span>
        )}
        {thread.canResolve && (
          <Button
            size="xs"
            variant="ghost"
            className={thread.resolved ? "ml-auto" : undefined}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate(!thread.resolved)}
          >
            {resolve.isPending
              ? "Saving..."
              : thread.resolved
                ? "Unresolve conversation"
                : "Resolve conversation"}
          </Button>
        )}
      </div>
      {resolve.error && (
        <p role="alert" className="mt-2 text-xs text-error-foreground">
          {resolve.error.message}
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-3">
          {context && (
            <div className="space-y-1">
              <p className="truncate font-mono text-2xs text-muted-foreground" title={thread.path}>
                {thread.path} · {where}
              </p>
              <DiffSnippet text={hunkTail(thread.diffHunk)} label={`Code at ${thread.path}`} />
            </div>
          )}
          {thread.comments.map((comment) => (
            <ThreadComment key={comment.id} comment={comment} />
          ))}
          {count > thread.comments.length && thread.comments[0] && (
            <a
              href={thread.comments[0].url}
              target="_blank"
              rel="noreferrer"
              className="block text-2xs text-muted-foreground hover:underline"
            >
              {count - thread.comments.length} more on GitHub
            </a>
          )}
          {thread.canReply &&
            (replying ? (
              <CommentForm
                label={`Reply to ${author}`}
                submitLabel="Reply"
                pendingLabel="Replying..."
                error={reply.error?.message ?? null}
                pending={reply.isPending}
                onSubmit={(body) => reply.mutate(body)}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <Button size="xs" variant="outline" onClick={() => setReplying(true)}>
                Reply
              </Button>
            ))}
        </div>
      )}
    </CommentCard>
  );
}
