import type { ChapterReview, ReviewProgress, RiskLevel } from "@prkit/contracts";

import { kindLabels } from "./kindLabels";
import { chapterRisk, RISK_LEVELS } from "./riskLevels";
import type { GuideChapter } from "./types";

type Kind = GuideChapter["kind"];

/**
 * prkit tells agents to order chapters core, supporting, data, config, tests, docs, generated
 * (apps/server/src/reviews/instructions.md), so each band is one run of that order and a guide
 * written in it gets at most three gaps.
 */
const BAND = {
  core: "change",
  supporting: "change",
  data: "setup",
  config: "setup",
  tests: "around",
  docs: "around",
  generated: "generated",
} as const satisfies Record<Kind, string>;

export type TickState = "pending" | "unmarked" | "unreviewed" | "partial" | "changed" | "reviewed";

export type RailTick = {
  readonly id: string;
  readonly index: number;
  readonly title: string;
  readonly kind: Kind;
  /** The guide moved to another band of chapters here. */
  readonly gapBefore: boolean;
  /** Generated chapters, which includes prkit's "Skipped by your ignore rules". */
  readonly quiet: boolean;
  /** How carefully to read it, when the guide is rated. */
  readonly risk: RiskLevel | "not-reviewed" | null;
} & (
  | { readonly state: "pending" | "unmarked"; readonly progress: null }
  | {
      readonly state: Exclude<TickState, "pending" | "unmarked">;
      readonly progress: ReviewProgress;
    }
);

export const railTicks = (
  chapters: ReadonlyArray<GuideChapter>,
  pending: ReadonlySet<string>,
  reviewOf: (chapter: GuideChapter) => ChapterReview | null,
  rated: boolean,
): RailTick[] =>
  chapters.map((chapter, index): RailTick => {
    const previous = chapters[index - 1];
    const base = {
      id: chapter.id,
      index,
      title: chapter.title,
      kind: chapter.kind,
      gapBefore: previous !== undefined && BAND[previous.kind] !== BAND[chapter.kind],
      quiet: chapter.kind === "generated",
      risk: chapterRisk(chapter, rated),
    };
    if (pending.has(chapter.id)) return { ...base, state: "pending", progress: null };
    const review = reviewOf(chapter);
    if (review === null) return { ...base, state: "unmarked", progress: null };
    return {
      ...base,
      state: review.progress.changed > 0 ? "changed" : review.state,
      progress: review.progress,
    };
  });

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;

// "Not reviewed" means the agent skipped it, which would read as the reader's own progress here.
const riskWords = (tick: RailTick) =>
  tick.risk === null || tick.risk === "not-reviewed"
    ? null
    : `${RISK_LEVELS[tick.risk].label} risk`;

/** The second line of a tick's tooltip. */
export const tickSummary = (tick: RailTick): string => {
  const risk = riskWords(tick);
  const kind = risk === null ? kindLabels[tick.kind] : `${kindLabels[tick.kind]} · ${risk}`;
  switch (tick.state) {
    case "pending":
      return "Being written";
    case "unmarked":
      return kind;
    case "changed":
      return `${kind} · ${tick.progress.changed} changed since you reviewed`;
    default:
      return `${kind} · ${tick.progress.reviewed} of ${tick.progress.total} reviewed`;
  }
};

/** `total` is null while a draft is still adding chapters. */
export const tickLabel = (tick: RailTick, total: number | null): string => {
  const risk = riskWords(tick);
  const head = `Chapter ${tick.index + 1}${total === null ? "" : ` of ${total}`}, ${tick.title}${risk === null ? "" : `, ${risk.toLowerCase()}`}`;
  switch (tick.state) {
    case "pending":
      return `${head}, being written`;
    case "unmarked":
      return head;
    case "changed":
      return `${head}, ${files(tick.progress.changed)} changed since you reviewed`;
    case "reviewed":
      return `${head}, reviewed`;
    default:
      return `${head}, ${tick.progress.reviewed} of ${tick.progress.total} files reviewed`;
  }
};
