import { Button } from "~/components/ui/button";
import { noNotesHere } from "./placeGuideNotes";
import type { FilesGuideNotesState } from "./useFilesGuideNotes";

/** What the tab row says about the notes: a few words with the whole story on hover, or an action. */
type NotesStatus =
  | {
      readonly _tag: "words";
      readonly words: string;
      readonly story?: string;
      readonly busy?: boolean;
    }
  | { readonly _tag: "failed"; readonly message: string; readonly retry: () => void }
  | {
      readonly _tag: "newer";
      readonly story: string;
      readonly loading: boolean;
      readonly show: () => void;
    };

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
      return { _tag: "words", words: "Loading guide notes...", busy: true };
    case "failed":
      return { _tag: "failed", message: state.message, retry: state.retry };
    case "hidden":
      return state.waiting ? { _tag: "words", words: "Guide notes show after your comment" } : null;
    case "ready":
      break;
  }
  const { notes, newer, hiding, updating } = state;
  if (hiding) return { _tag: "words", words: "Guide notes hide after your comment" };
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
    return { _tag: "newer", story, loading: newer.loading, show: newer.show };
  return {
    _tag: "words",
    story,
    words:
      newer !== null
        ? newer.taken
          ? "Newer notes show after your comment"
          : "Newer notes after your comment"
        : older
          ? "Guide notes from an older commit"
          : `${notes.hidden} guide ${notes.hidden === 1 ? "note" : "notes"} hidden`,
  };
};

// A column that may shrink to nothing: a narrow window cuts the words before the tab row scrolls.
const WORDS = "grid grid-cols-[minmax(0,max-content)] text-xs text-muted-foreground";

/** Beside the guide notes toggle, so nothing said about the notes ever moves the diffs. */
export function FilesGuideNotesStatus({ state }: { state: FilesGuideNotesState }) {
  const status = statusOf(state);
  if (status === null) return null;
  if (status._tag === "newer")
    return (
      <Button
        size="xs"
        variant="outline"
        title={status.story}
        disabled={status.loading}
        onClick={status.show}
      >
        {status.loading ? "Loading..." : "Show newer notes"}
      </Button>
    );
  if (status._tag === "failed")
    return (
      <span role="alert" className="flex items-center gap-1.5">
        <span className={WORDS}>
          <span className="truncate" title={`Couldn't load the guide's notes. ${status.message}`}>
            Guide notes unavailable
          </span>
        </span>
        <Button variant="ghost-muted" size="micro" onClick={status.retry}>
          Retry
        </Button>
      </span>
    );
  return (
    <span role="status" aria-busy={status.busy} className={WORDS}>
      <span className="truncate" title={status.story}>
        {status.words}
      </span>
    </span>
  );
}
