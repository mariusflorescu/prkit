import {
  anchorHolds,
  type CommentPlacement,
  type DiffFile,
  type DiffRow,
  diffRows,
  findSnippet,
  type LinePoint,
  noteKey,
  notePoint,
  type PendingComment,
  type PullRequestDetail,
  rangeRows,
  type ReviewCommentId,
  type ReviewThread,
} from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { DiffComments, LineRange } from "~/components/diff";
import { toastManager } from "~/components/ui/toast";
import { movePendingComment } from "~/rpc/client";
import { pendingCommentsQuery, reviewThreadsQuery } from "~/rpc/queries";
import { CommentPin } from "./CommentPin";
import { NoteCommentButton } from "./NoteCommentButton";
import { NoteCommentStatus } from "./NoteCommentStatus";
import { OutdatedComments } from "./OutdatedComments";
import { storePending } from "./reviewCommentsCache";
import { COMMENTABLE } from "./reviewCommentPresentation";
import { type NoteDraft, useReviewCommentsStore } from "./reviewCommentsStore";

export type CommentScope = {
  /** The head commit of the diff on screen. */
  commitSha: string;
  /** GitHub numbers its threads against the PR's current diff, so only that diff shows them. */
  threads: boolean;
  /** Whether drafts and threads whose lines are gone are listed under each file. */
  outdated: boolean;
  /** The guide revision on screen, whose question and risk notes can become drafts. Null on Files. */
  revision: number | null;
};

type Pin = {
  point: LinePoint;
  threads: Array<ReviewThread>;
  drafts: Array<PendingComment>;
  composer: { placement: CommentPlacement; note: NoteDraft | null } | null;
};

const locate = (
  rows: ReadonlyArray<DiffRow>,
  path: string,
  range: LineRange,
  commitSha: string,
): CommentPlacement | null => {
  const found = rangeRows(rows, range.start, range.end);
  return (
    found && {
      anchor: { path, start: found.start, end: found.end },
      snippet: found.snippet,
      commitSha,
    }
  );
};

/**
 * Review comments for the diffs of one PR, as a function from a file to its comment
 * layer. Drafts sit where their lines still read the same; others are outdated.
 */
export function useDiffComments(
  pr: Pick<PullRequestDetail, "key" | "accountId" | "headSha" | "baseSha">,
  files: ReadonlyArray<DiffFile>,
  scope: CommentScope,
) {
  const { key, accountId, headSha, baseSha } = pr;
  const client = useQueryClient();
  const pending = useQuery(pendingCommentsQuery(key, accountId));
  const threads = useQuery({ ...reviewThreadsQuery(key, accountId), enabled: scope.threads });
  const composer = useReviewCommentsStore((state) =>
    state.composer?.key === key ? state.composer : null,
  );
  const moving = useReviewCommentsStore((state) =>
    state.moving?.key === key ? state.moving : null,
  );
  const compose = useReviewCommentsStore((state) => state.compose);
  const stopMove = useReviewCommentsStore((state) => state.stopMove);
  const move = useMutation({
    mutationFn: (input: { id: ReviewCommentId; placement: CommentPlacement }) =>
      movePendingComment(input.id, input.placement),
    onSuccess: (comments) => {
      storePending(client, key, accountId)(comments);
      stopMove();
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't move the comment",
        description: error.message,
      }),
  });
  const moveComment = move.mutate;
  const { commitSha, outdated: showOutdated, revision } = scope;
  const drafts = pending.data?.comments;
  const fromNotes = pending.data?.fromNotes;
  // A note's composer sits on its revision's line numbers, so only that revision shows it.
  const shown =
    composer !== null && (composer.note === null || composer.note.ref.revision === revision)
      ? composer
      : null;
  // GitHub numbers threads against the head it had when they were read, so they are
  // placed only on a diff of that head, and read again once the diff moves on.
  const threadsHead = threads.data?.headSha;
  const threadList = scope.threads && threadsHead === commitSha ? threads.data?.threads : undefined;
  const staleThreads = scope.threads && threadsHead !== undefined && threadsHead !== commitSha;
  useEffect(() => {
    if (staleThreads)
      void client.invalidateQueries({ queryKey: reviewThreadsQuery(key, accountId).queryKey });
  }, [staleThreads, client, key, accountId]);
  return useMemo(() => {
    const owner = { key, accountId };
    const byNote = new Map((fromNotes ?? []).map((comment) => [comment.note, comment]));
    const build = (file: DiffFile): DiffComments | undefined => {
      if (drafts === undefined || file.patch._tag !== "text") return undefined;
      const rows = diffRows(file.patch.patch);
      const pins = new Map<string, Pin>();
      const pinAt = (point: LinePoint) => {
        const id = `${point.side}:${point.line}`;
        const pin = pins.get(id) ?? { point, threads: [], drafts: [], composer: null };
        pins.set(id, pin);
        return pin;
      };
      const fileDrafts = drafts.filter(
        (comment) => comment.state === "draft" && comment.anchor.path === file.path,
      );
      const fileThreads = (threadList ?? []).filter((thread) => thread.path === file.path);
      const outdatedThreads: Array<ReviewThread> = [];
      for (const thread of fileThreads) {
        if (thread.anchor && rangeRows(rows, thread.anchor.start, thread.anchor.end))
          pinAt(thread.anchor.end).threads.push(thread);
        else outdatedThreads.push(thread);
      }
      const outdatedDrafts: Array<{
        comment: PendingComment;
        suggestion: CommentPlacement | null;
      }> = [];
      for (const comment of fileDrafts) {
        if (anchorHolds(rows, comment.anchor, comment.snippet))
          pinAt(comment.anchor.end).drafts.push(comment);
        else {
          const anchor = findSnippet(rows, file.path, comment.snippet);
          outdatedDrafts.push({
            comment,
            suggestion: anchor && { anchor, snippet: comment.snippet, commitSha },
          });
        }
      }
      const open =
        shown?.path === file.path ? locate(rows, file.path, shown.range, commitSha) : null;
      if (open) pinAt(open.anchor.end).composer = { placement: open, note: shown?.note ?? null };
      return {
        pins: [...pins.values()].map((pin) => pin.point),
        render: (point) => {
          const pin = pins.get(`${point.side}:${point.line}`);
          return (
            pin && (
              <CommentPin
                pr={owner}
                threads={pin.threads}
                drafts={pin.drafts}
                composer={pin.composer}
              />
            )
          );
        },
        selection: open && { start: open.anchor.start, end: open.anchor.end },
        onSelect: (range) => {
          const placement = locate(rows, file.path, range, commitSha);
          if (placement === null)
            toastManager.add({
              type: "warning",
              title: "Pick lines inside the diff",
              description: "GitHub takes review comments only on lines shown in a hunk.",
            });
          else if (moving?.path === file.path) moveComment({ id: moving.id, placement });
          else
            compose({
              key,
              path: file.path,
              range: { start: placement.anchor.start, end: placement.anchor.end },
              note: null,
            });
        },
        footer:
          showOutdated && (outdatedDrafts.length > 0 || outdatedThreads.length > 0) ? (
            <OutdatedComments
              pr={owner}
              path={file.path}
              drafts={outdatedDrafts}
              threads={outdatedThreads}
            />
          ) : null,
        count: fileDrafts.length + fileThreads.length,
        noteFooter:
          revision === null
            ? undefined
            : (note, index) => {
                if (!COMMENTABLE[note.tone]) return null;
                const id = noteKey(file.path, rows, note);
                const comment = id === null ? undefined : byNote.get(id);
                if (comment === undefined)
                  return (
                    <NoteCommentButton
                      pr={{ key, accountId, headSha, baseSha }}
                      path={file.path}
                      rows={rows}
                      revision={revision}
                      note={note}
                      index={index}
                      composing={
                        shown?.note?.ref.path === file.path && shown.note.ref.index === index
                      }
                    />
                  );
                const point = notePoint(note);
                const { end } = comment.anchor;
                return (
                  <NoteCommentStatus
                    comment={comment}
                    pinned={
                      end.side === point.side &&
                      end.line === point.line &&
                      anchorHolds(rows, comment.anchor, comment.snippet)
                    }
                  />
                );
              },
      };
    };
    const layers = new Map(files.map((file) => [file.path, build(file)]));
    return (file: DiffFile) => layers.get(file.path);
  }, [
    key,
    accountId,
    headSha,
    baseSha,
    files,
    drafts,
    fromNotes,
    threadList,
    shown,
    moving,
    commitSha,
    showOutdated,
    revision,
    compose,
    moveComment,
  ]);
}
