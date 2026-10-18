import {
  READING,
  type PullRequestSize,
  type ReviewWait,
  SIZE_BUCKETS,
  sizeSetByFiles,
} from "@prkit/contracts";

export const readingTimeLabel = (minutes: number) => {
  if (minutes < 60) return `${minutes} min`;
  if (minutes >= READING.longestMinutes) return `${READING.longestMinutes / 60} h+`;
  return `${Math.round(minutes / 30) / 2} h`;
};

export const sizeEvidence = (size: PullRequestSize) => {
  const row = SIZE_BUCKETS.find((item) => item.bucket === size.bucket);
  return [
    `${row?.name ?? size.bucket}: ${size.lines} changed ${size.lines === 1 ? "line" : "lines"} (+${size.additions} -${size.deletions}) in ${size.files} ${size.files === 1 ? "file" : "files"}.`,
    sizeSetByFiles(size) ? "The number of files sets the size." : null,
    `About ${size.readingMinutes} ${size.readingMinutes === 1 ? "minute" : "minutes"} to read, at about ${READING.linesPerMinute} lines a minute and half a minute per file.`,
  ]
    .filter((part) => part !== null)
    .join(" ");
};

const EVENT_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export const formatEventDate = (iso: string) => EVENT_DATE.format(Date.parse(iso));

const askedOf = (via: Extract<ReviewWait, { _tag: "waiting" }>["via"]) =>
  via._tag === "you"
    ? "Your review was requested"
    : `A review was requested from ${via.teams.join(" and ")}`;

export const waitEvidence = (wait: ReviewWait) => {
  switch (wait._tag) {
    case "draft":
      return "Still a draft, so it isn't waiting on you yet.";
    case "unknown":
      return wait.reason === "not-read"
        ? "prkit couldn't read when your review was requested. Refresh to try again."
        : wait.reason === "unreadable"
          ? "GitHub gave nothing for this pull request's history, so prkit can't say when you were asked."
          : "GitHub's recent history of this pull request doesn't say when you were asked.";
    case "waiting": {
      const asked = askedOf(wait.via);
      if (wait.cause === "ready")
        return `${asked} while it was a draft. It was marked ready on ${formatEventDate(wait.since)}.`;
      if (wait.via._tag === "teams" && wait.atLeast)
        return `${asked}. GitHub doesn't say which team is yours, so this counts from the latest request and the wait may be longer.`;
      if (wait.atLeast)
        return `${asked} before the 20 latest review events prkit reads, so it has waited at least since ${formatEventDate(wait.since)}.`;
      return `${asked}${wait.cause === "requested-again" ? " again" : ""} on ${formatEventDate(wait.since)}.`;
    }
  }
};
