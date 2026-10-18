import { Button } from "~/components/ui/button";
import type { FilesGuideNotesState } from "./useFilesGuideNotes";

const LINE =
  "flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground";

const hiddenWords = (hidden: number, older: boolean) => {
  if (hidden === 0) return false;
  const one = hidden === 1;
  return older
    ? `${hidden} no longer ${one ? "matches and is" : "match and are"} hidden.`
    : `${hidden} guide ${one ? "note is" : "notes are"} hidden: GitHub's diff doesn't show ${one ? "its line" : "their lines"} now.`;
};

/** One quiet line above the Files list, when the guide's notes there need a word. */
export function FilesGuideNotesStatus({ state }: { state: FilesGuideNotesState }) {
  if (state._tag === "loading")
    return (
      <p role="status" aria-busy="true" className={LINE}>
        Loading guide notes...
      </p>
    );
  if (state._tag === "failed")
    return (
      <div role="alert" className={LINE}>
        <p>Couldn't load the guide's notes. {state.message}</p>
        <Button size="xs" variant="outline" onClick={state.retry}>
          Retry
        </Button>
      </div>
    );
  if (state._tag === "hidden" && state.waiting)
    return (
      <p role="status" className={LINE}>
        Guide notes show once your comment is done.
      </p>
    );
  if (state._tag !== "ready") return null;
  const { notes, newer, hiding, updating } = state;
  if (hiding)
    return (
      <p role="status" className={LINE}>
        Guide notes hide once your comment is done.
      </p>
    );
  const words = [
    notes.older &&
      `Guide notes come from r${notes.revision}, written for an older commit. They show only where the code still reads the same.`,
    hiddenWords(notes.hidden, notes.older),
    notes.older && newer === null && updating && "prkit is updating the guide.",
    newer !== null &&
      (newer.taken
        ? "A newer guide is ready. Its notes show once your comment is done."
        : newer.show === null
          ? "A newer guide is ready. You can show its notes once your comment is done."
          : "A newer guide is ready."),
  ].filter((part) => part !== false);
  if (words.length === 0) return null;
  return (
    <div role="status" className={LINE}>
      <p>{words.join(" ")}</p>
      {newer?.show != null && (
        <Button size="xs" variant="outline" disabled={newer.loading} onClick={newer.show}>
          {newer.loading ? "Loading..." : "Show its notes"}
        </Button>
      )}
    </div>
  );
}
