import { place, type PullRequestDetail, type ReviewEvent } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { refreshPullRequestReads } from "~/features/github/pullRequestReads";
import { submitReview } from "~/rpc/client";
import { pendingCommentsQuery, pullRequestFilesQuery, reviewThreadsQuery } from "~/rpc/queries";

const movedClause = (moved: number) => `${moved} moved with ${moved === 1 ? "its" : "their"} code.`;

const EVENTS: ReadonlyArray<{
  value: ReviewEvent;
  label: string;
  hint: string;
  verdict: boolean;
}> = [
  {
    value: "comment",
    label: "Comment",
    hint: "Submit general feedback without explicit approval.",
    verdict: false,
  },
  {
    value: "approve",
    label: "Approve",
    hint: "Give your approval to merge these changes.",
    verdict: true,
  },
  {
    value: "request-changes",
    label: "Request changes",
    hint: "Submit feedback that must be addressed before merging.",
    verdict: true,
  },
];

/** GitHub's "Finish your review": a summary, a verdict, and every draft as one review. */
export function FinishReviewForm({
  detail,
  onDone,
}: {
  detail: PullRequestDetail;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const login = detail.accountId.slice(detail.accountId.indexOf("/") + 1);
  const own = detail.author?.login === login;
  const pending = useQuery(pendingCommentsQuery(detail.key, detail.accountId));
  const files = useQuery(
    pullRequestFilesQuery(detail.key, detail.accountId, detail.headSha, detail.baseSha),
  );
  const drafts = pending.data?.comments.filter((comment) => comment.state === "draft") ?? [];
  const diff = files.data;
  const placed = diff ? drafts.map((comment) => place(comment, diff)._tag) : [];
  const outdated = placed.filter((tag) => tag === "outdated").length;
  const moved = placed.filter((tag) => tag === "moved").length;
  const ready = drafts.length - outdated;
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<{ body: string; event: ReviewEvent }>({
    defaultValues: { body: "", event: "comment" },
  });
  const event = useWatch({ control, name: "event" });
  const rereadDrafts = () =>
    client.invalidateQueries({
      queryKey: pendingCommentsQuery(detail.key, detail.accountId).queryKey,
    });
  // The PR may have moved since this window read it; reading it again shows which
  // drafts still sit on current lines.
  const rereadGitHub = () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: reviewThreadsQuery(detail.key, detail.accountId).queryKey,
      }),
      refreshPullRequestReads(client, detail.key, detail.accountId),
    ]).catch(() => undefined);
  const submit = useMutation({
    mutationFn: (values: { body: string; event: ReviewEvent }) =>
      submitReview({ key: detail.key, accountId: detail.accountId, ...values }),
    // Drafts come from prkit's own store, so this read is quick. GitHub's reads, which the
    // watcher can keep restarting for seconds, go on behind the error or the toast.
    onError: async () => {
      await rereadDrafts();
      void rereadGitHub();
    },
    onSuccess: async (result) => {
      // A popover reopened at once never offers the posted drafts.
      await rereadDrafts();
      void rereadGitHub();
      toastManager.add({
        type: "success",
        title: "Review submitted",
        description: [
          `${result.posted} ${result.posted === 1 ? "comment" : "comments"} posted on GitHub.`,
          result.moved > 0 && movedClause(result.moved),
          result.outdated > 0 &&
            `${result.outdated} outdated ${result.outdated === 1 ? "draft stays" : "drafts stay"} in prkit.`,
        ]
          .filter(Boolean)
          .join(" "),
      });
      onDone();
    },
  });
  const send = handleSubmit((values) => submit.mutate({ ...values, body: values.body.trim() }));
  return (
    <form noValidate onSubmit={(event) => void send(event)} className="mt-3 space-y-3">
      <textarea
        autoFocus
        rows={4}
        aria-label="Review summary"
        aria-invalid={Boolean(errors.body)}
        placeholder="Leave a summary. Markdown works."
        disabled={submit.isPending}
        className="field-sizing-content block max-h-64 min-h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error"
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
            keyEvent.preventDefault();
            if (!keyEvent.repeat) void send();
          }
        }}
        {...register("body", {
          validate: (body, values) =>
            values.event === "approve" ||
            body.trim().length > 0 ||
            ready > 0 ||
            "Write a summary or add comments to the diff first.",
        })}
      />
      {errors.body && (
        <p role="alert" className="text-xs text-error-foreground">
          {errors.body.message}
        </p>
      )}
      <fieldset className="space-y-2" disabled={submit.isPending}>
        <legend className="sr-only">Review verdict</legend>
        {EVENTS.map((option) => {
          const blocked = option.verdict && own;
          return (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-60"
            >
              <input
                type="radio"
                value={option.value}
                disabled={blocked}
                aria-label={option.label}
                aria-describedby={`review-event-${option.value}`}
                className="mt-1"
                {...register("event")}
              />
              <span>
                <span className="block font-medium">{option.label}</span>
                <span
                  id={`review-event-${option.value}`}
                  className="block text-xs text-muted-foreground"
                >
                  {option.hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {own && (
        <p className="text-xs text-muted-foreground">
          This is your pull request, so GitHub only lets you comment on it.
        </p>
      )}
      <p className="text-xs text-muted-foreground" role="status">
        {ready === 0
          ? "No pending comments."
          : `${ready} pending ${ready === 1 ? "comment" : "comments"} will be posted.`}
        {moved > 0 && ` ${movedClause(moved)}`}
        {outdated > 0 &&
          ` ${outdated} outdated ${outdated === 1 ? "draft stays" : "drafts stay"} in prkit until moved to a current line.`}
      </p>
      {submit.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {submit.error.message} Your drafts are still here.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submit.isPending}>
          {submit.isPending
            ? "Submitting..."
            : event === "approve"
              ? "Approve"
              : event === "request-changes"
                ? "Request changes"
                : "Submit review"}
        </Button>
      </div>
    </form>
  );
}
