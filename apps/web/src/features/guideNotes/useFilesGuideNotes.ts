import type { PullRequestDetail, PullRequestFiles } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useNoteComposerHold } from "~/features/reviewComments/useNoteComposerHold";
import { guideQuery, reviewQuery } from "~/rpc/queries";
import { type FilesGuideNotes, placeGuideNotes } from "./placeGuideNotes";

export type FilesGuideNotesState =
  /** No accepted guide: no toggle, no notes, nothing to say. */
  | { readonly _tag: "none" }
  /** None on screen, so the guide isn't read. `waiting` when they show once a comment is done. */
  | { readonly _tag: "hidden"; readonly waiting: boolean }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly message: string; readonly retry: () => void }
  | {
      readonly _tag: "ready";
      readonly notes: FilesGuideNotes;
      /**
       * A guide accepted since the tab took its notes. `show` is null while a comment is written;
       * `taken` once the reader asked for it and it waits for the comment to be done.
       */
      readonly newer: {
        readonly show: (() => void) | null;
        readonly loading: boolean;
        readonly taken: boolean;
      } | null;
      /** The reader hid them while writing a comment; they go once it is done. */
      readonly hiding: boolean;
      /** prkit is writing a new revision. */
      readonly updating: boolean;
    };

/**
 * The latest guide's notes on GitHub's diff. The tab takes the newest revision when its notes
 * first load or are turned on and keeps it: a revision accepted later is offered instead. A
 * push places the kept revision's notes again, together with the new diff.
 */
export function useFilesGuideNotes(
  detail: PullRequestDetail,
  files: PullRequestFiles | undefined,
  shown: boolean,
  /** Words are being written in a form inside this PR's diffs. */
  writing: boolean,
): FilesGuideNotesState {
  const client = useQueryClient();
  const review = useQuery(reviewQuery(detail.key));
  const latest = review.data?.revisions.at(-1)?.revision ?? null;
  useNoteComposerHold(detail.key, "files");
  const [taken, setTaken] = useState<number | null>(null);
  const wanted = shown ? (taken ?? latest) : null;
  // Pierre keys a diff's annotations by position, so notes that came or went under an open
  // form would remount it and lose its words. What is on screen waits until it closes.
  const [displayed, setDisplayed] = useState(wanted);
  if (displayed !== wanted && !writing) setDisplayed(wanted);
  if (shown && taken === null && displayed !== null) setTaken(displayed);
  // Hiding lets go of the taken revision, and of a newer one still being read for it.
  const [choice, setChoice] = useState(0);
  if (!shown && taken !== null && displayed === null) {
    setChoice(choice + 1);
    setTaken(null);
  }
  // The newer guide is read before it is taken, so a failed read keeps the notes on screen.
  const adopt = useMutation({
    mutationFn: ({ next }: { next: number; choice: number }) =>
      client.fetchQuery(guideQuery(detail.key, next)).then(() => next),
    onSuccess: (next, asked) => {
      if (asked.choice === choice) setTaken(next);
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't load the newer guide's notes",
        description: error.message,
      }),
  });
  const guide = useQuery({
    ...guideQuery(detail.key, displayed ?? 0),
    enabled: displayed !== null,
  });
  const placed = useMemo(
    () => (guide.data && files ? placeGuideNotes(guide.data, files) : null),
    [guide.data, files],
  );
  // Notes that finish loading under an open form wait too. Notes already on screen still follow
  // a push, which only moves them in files whose cards remount anyway.
  const [notes, setNotes] = useState(placed);
  if (notes !== placed && (!writing || (notes !== null && placed !== null))) setNotes(placed);
  if (displayed === null) {
    if (latest === null) {
      if (shown && review.isError)
        return {
          _tag: "failed",
          message: review.error.message,
          retry: () => void review.refetch(),
        };
      return shown && review.isPending ? { _tag: "loading" } : { _tag: "none" };
    }
    return { _tag: "hidden", waiting: wanted !== null };
  }
  if (notes === null) {
    if (guide.isError)
      return { _tag: "failed", message: guide.error.message, retry: () => void guide.refetch() };
    return { _tag: "loading" };
  }
  const status = review.data?.review?.status._tag;
  return {
    _tag: "ready",
    notes,
    newer:
      latest !== null && latest > displayed
        ? {
            show: writing ? null : () => adopt.mutate({ next: latest, choice }),
            loading: adopt.isPending,
            taken: taken !== null && taken > displayed,
          }
        : null,
    hiding: wanted === null,
    updating: status === "preparing" || status === "writing",
  };
}
