import { useId } from "react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { noNotesHere } from "./placeGuideNotes";
import type { FilesGuideNotesState } from "./useFilesGuideNotes";

/** What the tab row says about the notes. */
type NotesStatus = {
  /** On the row, cut short when the window is narrow. */
  readonly words: string;
  /** All of it, on hover and focus, and read out with the words. */
  readonly story: string;
  readonly busy: boolean;
  /** Beside the words, so what the keyboard is on never turns into something else. */
  readonly action: { readonly _tag: "retry" | "show"; readonly run: () => void } | null;
};

const said = (words: string, story = words): NotesStatus => ({
  words,
  story,
  busy: false,
  action: null,
});

const hiddenWords = (hidden: number, older: boolean) => {
  if (hidden === 0) return false;
  const one = hidden === 1;
  return older
    ? `${hidden} no longer ${one ? "matches and is" : "match and are"} hidden.`
    : `${hidden} guide ${one ? "note is" : "notes are"} hidden: GitHub's diff doesn't show ${one ? "its line" : "their lines"} now.`;
};

const statusOf = (state: FilesGuideNotesState): NotesStatus | null => {
  switch (state._tag) {
    case "none":
      return null;
    case "loading":
      return { ...said("Loading guide notes..."), busy: true };
    case "failed":
      return {
        ...said("Guide notes unavailable", `Couldn't load the guide's notes. ${state.message}`),
        action: { _tag: "retry", run: state.retry },
      };
    case "hidden":
      return state.waiting ? said("Guide notes show after your comment") : null;
    case "ready":
      break;
  }
  const { notes, newer, hiding, updating } = state;
  if (hiding) return said("Guide notes hide after your comment");
  // A guide with nothing for these files has nothing to qualify.
  const older = notes.older && !noNotesHere(notes);
  const story = [
    older &&
      `Guide notes come from r${notes.revision}, written for an older commit. They show only where the code still reads the same.`,
    hiddenWords(notes.hidden, older),
    older && newer === null && updating && "prkit is updating the guide.",
    newer !== null &&
      (newer.taken
        ? "A newer guide is ready. Its notes show once your comment is done."
        : newer.show === null
          ? "A newer guide is ready. You can show its notes once your comment is done."
          : "A newer guide is ready."),
  ]
    .filter((part) => part !== false)
    .join(" ");
  if (story === "") return null;
  if (newer?.show != null)
    return {
      ...said("Newer guide", story),
      busy: newer.loading,
      action: { _tag: "show", run: newer.show },
    };
  return said(
    newer !== null
      ? newer.taken
        ? "Newer notes show after your comment"
        : "Newer notes after your comment"
      : older
        ? "Guide notes from an older commit"
        : `${notes.hidden} guide ${notes.hidden === 1 ? "note" : "notes"} hidden`,
    story,
  );
};

/**
 * Beside the guide notes toggle, so nothing said about the notes ever moves the diffs. One live
 * region for as long as the toggle is there, so a screen reader hears each change.
 */
export function FilesGuideNotesStatus({ state }: { state: FilesGuideNotesState }) {
  const storyId = useId();
  const status = statusOf(state);
  const told = status !== null && status.story !== status.words;
  return (
    <span
      role="status"
      aria-atomic="true"
      aria-busy={status?.busy === true || undefined}
      data-guide-notes-status=""
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      {status !== null && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                // A column that may shrink to nothing: a narrow window cuts the words short
                // before the tab row scrolls.
                <button
                  type="button"
                  aria-describedby={told ? storyId : undefined}
                  className="-mx-1 grid grid-cols-[minmax(0,max-content)] rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <span className="truncate">{status.words}</span>
            </TooltipTrigger>
            <TooltipPopup>{status.story}</TooltipPopup>
          </Tooltip>
          {told && (
            <span id={storyId} className="sr-only">
              {status.story}
            </span>
          )}
          {status.action !== null && (
            <Button
              variant={status.action._tag === "show" ? "outline" : "ghost-muted"}
              size="micro"
              disabled={status.busy}
              onClick={status.action.run}
            >
              {status.action._tag === "retry"
                ? "Retry"
                : status.busy
                  ? "Loading..."
                  : "Show its notes"}
            </Button>
          )}
        </>
      )}
    </span>
  );
}
