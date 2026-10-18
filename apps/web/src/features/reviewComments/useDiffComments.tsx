import {
  type AccountId,
  capture,
  type CommentPlacement,
  type DiffFile,
  diffRows,
  inOneHunk,
  type Landed,
  type LinePoint,
  notePoint,
  type Outdated,
  type PendingComment,
  place,
  type PullRequestKey,
  type ReviewCommentId,
  type ReviewThread,
} from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { DiffComments } from "~/components/diff";
import { toastManager } from "~/components/ui/toast";
import type { FilesGuideNotes } from "~/features/guideNotes/placeGuideNotes";
import { movePendingComment } from "~/rpc/client";
import { pendingCommentsQuery, reviewThreadsQuery } from "~/rpc/queries";
import { CommentPin } from "./CommentPin";
import { NoteCommentFooter } from "./NoteCommentFooter";
import { OutdatedComments } from "./OutdatedComments";
import { storePending } from "./reviewCommentsCache";
import { type NoteDraft, useReviewCommentsStore } from "./reviewCommentsStore";
import { sameRef, type ShownNote } from "./shownNote";

/**
 * Where the guide notes on screen come from, so their question and risk notes can become
 * drafts: a revision's own diff on the Guide, or the latest guide's notes placed on GitHub's
 * diff on Files (null while Files shows none).
 */
export type NoteSite =
  | { readonly on: "guide"; readonly revision: number }
  | { readonly on: "files"; readonly notes: FilesGuideNotes | null };

export type CommentScope = {
  /** The head commit of the diff on screen. */
  commitSha: string;
  /** GitHub numbers its threads against the PR's current diff, so only that diff shows them. */
  threads: boolean;
  /** Whether drafts and threads whose lines are gone are listed under each file. */
  outdated: boolean;
  notes: NoteSite | null;
};

type Pin = {
  point: LinePoint;
  threads: Array<ReviewThread>;
  drafts: Array<{ comment: PendingComment; placed: Landed }>;
  composer: { placement: CommentPlacement; note: NoteDraft | null } | null;
};

/**
 * Review comments for the diffs of one PR, as a function from a file to its comment
 * layer. Drafts sit where their lines, and the lines around them, read the same; others
 * are outdated.
 */
export function useDiffComments(
  pr: { key: PullRequestKey; accountId: AccountId },
  files: ReadonlyArray<DiffFile>,
  scope: CommentScope,
) {
  const { key, accountId } = pr;
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
  const { commitSha, outdated: showOutdated } = scope;
  // Read apart, so a caller's new scope object each render keeps the layers as they were.
  const noteOn = scope.notes?.on ?? null;
  const guideRevision = scope.notes?.on === "guide" ? scope.notes.revision : null;
  const filesNotes = scope.notes?.on === "files" ? scope.notes.notes : null;
  const drafts = pending.data?.comments;
  const fromNotes = pending.data?.fromNotes;
  // A note's composer sits on the line numbers of the diff it was opened on, so only that
  // surface shows it, and on the Guide only that revision.
  const visibleComposer =
    composer !== null &&
    (composer.note === null ||
      (composer.note.on === noteOn &&
        (noteOn === "files" || composer.note.ref.revision === guideRevision)))
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
        if (thread.anchor && inOneHunk(rows, thread.anchor.start, thread.anchor.end))
          pinAt(thread.anchor.end).threads.push(thread);
        else outdatedThreads.push(thread);
      }
      const outdatedDrafts: Array<{ comment: PendingComment; placed: Outdated }> = [];
      for (const comment of fileDrafts) {
        const placed = place(comment, rows, commitSha);
        if (placed._tag === "outdated") outdatedDrafts.push({ comment, placed });
        else pinAt(placed.placement.anchor.end).drafts.push({ comment, placed });
      }
      // The Guide draws a revision's notes on that revision's rows, at their own lines and
      // by their place among the file's notes. Files draws placed copies, known by identity.
      const shownNote = (note: ShownNote["written"], index: number): ShownNote | null => {
        if (guideRevision !== null)
          return {
            on: "guide",
            ref: { revision: guideRevision, path: file.path, index },
            written: note,
            writtenRows: rows,
            writtenHead: commitSha,
            at: notePoint(note),
            rows,
            head: commitSha,
          };
        const placed = filesNotes?.byShown.get(note);
        return placed === undefined ? null : { on: "files", ...placed, rows, head: commitSha };
      };
      const open =
        visibleComposer?.path === file.path
          ? capture(rows, { path: file.path, ...visibleComposer.range }, commitSha)
          : null;
      if (open)
        pinAt(open.anchor.end).composer = { placement: open, note: visibleComposer?.note ?? null };
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
          const placement = capture(rows, { path: file.path, ...range }, commitSha);
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
          noteOn === null
            ? undefined
            : (note, index) => {
                const shown = shownNote(note, index);
                return (
                  shown && (
                    <NoteCommentFooter
                      pr={owner}
                      note={shown}
                      fromNotes={byNote}
                      composing={
                        visibleComposer?.note != null &&
                        sameRef(visibleComposer.note.ref, shown.ref)
                      }
                    />
                  )
                );
              },
      };
    };
    const layers = new Map(files.map((file) => [file.path, build(file)]));
    return (file: DiffFile) => layers.get(file.path);
  }, [
    key,
    accountId,
    files,
    drafts,
    fromNotes,
    threadList,
    visibleComposer,
    moving,
    commitSha,
    showOutdated,
    noteOn,
    guideRevision,
    filesNotes,
    compose,
    moveComment,
  ]);
}
