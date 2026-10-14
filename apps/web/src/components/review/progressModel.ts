import type { AttemptSummary } from "@prkit/contracts";

export type GuideStage = "queued" | "preparing" | "reading" | "writing" | "checking";

export interface GuideProgress {
  readonly stage: GuideStage;
  /**
   * 0 to 1, from real counts only: files read fill the first half, chapters written
   * the second. It moves when one of them changes and stands still otherwise.
   */
  readonly fraction: number;
  /** "3 of 5 files", "Writing chapter 2 of 3". */
  readonly label: string;
  /** For the tab tooltip: "3/5 files", "chapter 2 of 3". */
  readonly short: string;
}

/** Where an attempt is, in words and as a fraction, from what the server reported. */
export const guideProgress = (attempt: AttemptSummary): GuideProgress => {
  const total = attempt.files.length;
  const read = attempt.files.filter((file) => file.read === "read").length;
  const chapters = attempt.draft?.chapters ?? [];
  const written = chapters.filter((chapter) => chapter.written).length;
  const reading = total === 0 ? 0 : 0.5 * (read / total);
  const writing = chapters.length === 0 ? 0.5 : 0.5 + 0.45 * (written / chapters.length);
  switch (attempt.phase) {
    case "queued":
      return { stage: "queued", fraction: 0, label: "Waiting for a free agent", short: "waiting" };
    case "preparing-code":
      return {
        stage: "preparing",
        fraction: 0,
        label: "Preparing the code",
        short: "preparing the code",
      };
    case "reading-change":
      return {
        stage: "reading",
        fraction: reading,
        label: `${read} of ${total} ${total === 1 ? "file" : "files"}`,
        short: `${read}/${total} files`,
      };
    case "writing-guide": {
      if (chapters.length === 0)
        return { stage: "writing", fraction: 0.5, label: "Writing the guide", short: "writing" };
      // Chapters written so far, with no plan to count against: the bar can't say how far along it is.
      if (attempt.draft?.growing === true)
        return {
          stage: "writing",
          fraction: 0.5,
          label: `Writing chapter ${written + 1}`,
          short: `chapter ${written + 1}`,
        };
      const current = Math.min(written + 1, chapters.length);
      return {
        stage: "writing",
        fraction: writing,
        label:
          written === chapters.length
            ? `Finishing the guide · ${chapters.length} chapters written`
            : `Writing chapter ${current} of ${chapters.length}`,
        short: `chapter ${current} of ${chapters.length}`,
      };
    }
    case "checking-guide":
      return { stage: "checking", fraction: 0.95, label: "Checking the guide", short: "checking" };
  }
};
