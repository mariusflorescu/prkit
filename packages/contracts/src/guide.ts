import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RiskSignal } from "./guideConfig.ts";

export const GuideKind = Schema.Literals([
  "core",
  "supporting",
  "data",
  "tests",
  "config",
  "docs",
  "generated",
]);
export const GuideTone = Schema.Literals(["risk", "question", "note"]);
export const GuideSide = Schema.Literals(["additions", "deletions"]);
export const GuideFlowStatus = Schema.Literals(["added", "changed", "removed", "unchanged"]);
export const GuideFlowDirection = Schema.Literals(["auto", "LR", "TB"]);
export const GuideRowStatus = Schema.Literals(["added", "removed", "unchanged"]);
export const GuideRowDepth = Schema.Literals([0, 1, 2, 3]);
/**
 * The agent's answer to one of the reviewer's focus areas. `notable` points at the
 * chapter that explains it; `not-assessed` says why the PR gave nothing to judge.
 */
export const FocusVerdict = Schema.Literals(["notable", "nothing-notable", "not-assessed"]);
export type FocusVerdict = typeof FocusVerdict.Type;
/** How carefully the reviewer should read. Never whether it is safe to merge. */
export const RiskLevel = Schema.Literals(["low", "medium", "high"]);
export type RiskLevel = typeof RiskLevel.Type;
/** low < medium < high, from the literal order. */
export const riskRank = (level: RiskLevel) => RiskLevel.literals.indexOf(level);

const Paragraphs = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const ChapterReference = Schema.Union([Schema.String, Schema.Int]);
const Callout = Schema.Struct({
  tone: Schema.optionalKey(GuideTone),
  text: Schema.String,
});
const Annotation = Schema.Struct({
  line: Schema.Int,
  side: Schema.optionalKey(GuideSide),
  tone: Schema.optionalKey(GuideTone),
  text: Schema.String,
});
const FileEntry = Schema.Union([
  Schema.String,
  Schema.Struct({
    path: Schema.String,
    note: Schema.optionalKey(Schema.String),
    annotations: Schema.optionalKey(Schema.Array(Annotation)),
    collapsed: Schema.optionalKey(Schema.Boolean),
  }),
]);

/** A line of the PR's new side, numbered as the numbered diff numbers it. */
export const DiffLineRef = Schema.Struct({ path: Schema.String, line: Schema.Int });
export type DiffLineRef = typeof DiffLineRef.Type;

// The evidence keys are optional so that a guide missing one gets a plain-word error from
// `normalize` and stays available to `revise_guide`.
const PullRequestRisk = Schema.Struct({
  level: RiskLevel,
  reasons: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        chapter: Schema.optionalKey(ChapterReference),
        /** A new-side line of a file in that chapter. */
        at: Schema.optionalKey(DiffLineRef),
      }),
    ),
  ),
});
const ChapterRisk = Schema.Struct({
  level: RiskLevel,
  reasons: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        /** A file of this chapter. */
        file: Schema.optionalKey(Schema.String),
        /** A new-side line of that file inside a hunk. */
        line: Schema.optionalKey(Schema.Int),
      }),
    ),
  ),
});

const chapterFields = {
  id: Schema.optionalKey(Schema.String),
  title: Schema.String,
  kind: Schema.optionalKey(GuideKind),
  body: Schema.optionalKey(Paragraphs),
  pseudocode: Schema.optionalKey(Schema.String),
  callouts: Schema.optionalKey(Schema.Array(Callout)),
  risk: Schema.optionalKey(ChapterRisk),
};
const FlowNode = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(GuideFlowStatus),
  chapter: Schema.optionalKey(ChapterReference),
  detail: Schema.optionalKey(Schema.String),
});
const FlowEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  label: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(GuideFlowStatus),
});
const BehaviorRow = Schema.Struct({
  text: Schema.String,
  /** Defaults to `unchanged`: a context row. */
  status: Schema.optionalKey(GuideRowStatus),
  depth: Schema.optionalKey(Schema.Int),
  at: DiffLineRef,
  chapter: Schema.optionalKey(ChapterReference),
});
/**
 * The Overview's before/after in one of two forms: a graph (`nodes` and `edges`) or a
 * behavior diff (`rows`). Every form key is optional so that both or neither reach
 * `normalize`, which accepts exactly one and says what to send instead.
 */
const Flow = Schema.Struct({
  title: Schema.String,
  subtitle: Schema.optionalKey(Schema.String),
  /** Graph only; a behavior diff ignores it. */
  direction: Schema.optionalKey(GuideFlowDirection),
  nodes: Schema.optionalKey(Schema.Array(FlowNode)),
  edges: Schema.optionalKey(Schema.Array(FlowEdge)),
  rows: Schema.optionalKey(Schema.Array(BehaviorRow)),
});
const Focus = Schema.Array(
  Schema.Struct({
    tone: Schema.optionalKey(GuideTone),
    text: Schema.String,
    chapter: Schema.optionalKey(Schema.String),
  }),
);

const FocusAreaAnswers = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    verdict: FocusVerdict,
    text: Schema.optionalKey(Schema.String),
    chapter: Schema.optionalKey(ChapterReference),
  }),
);

/**
 * Where the description and the code disagree: the code does something the description
 * doesn't mention, the description claims something nothing in the diff does, or the two
 * say different things.
 */
export const PreflightClaimKind = Schema.Literals([
  "missing-from-description",
  "missing-from-code",
  "differs",
]);
export type PreflightClaimKind = typeof PreflightClaimKind.Type;
const PreflightPointer = {
  chapter: Schema.optionalKey(ChapterReference),
  at: Schema.optionalKey(DiffLineRef),
};
/** Only on the author's own pull request. Every list may be empty: nothing to flag. */
const Preflight = Schema.Struct({
  questions: Schema.optionalKey(
    Schema.Array(Schema.Struct({ text: Schema.String, ...PreflightPointer })),
  ),
  description: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: PreflightClaimKind,
        text: Schema.String,
        /** The description's own words, for a claim it makes. */
        quote: Schema.optionalKey(Schema.String),
        ...PreflightPointer,
      }),
    ),
  ),
  tests: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        /** A changed source file that no test covers. */
        path: Schema.String,
        line: Schema.optionalKey(Schema.Int),
      }),
    ),
  ),
});

/**
 * How a person sees the change working by hand: the agent's suggestion from reading the
 * code, never something it ran. No steps and a `reason` when there is nothing to check by
 * hand. `steps` is optional so that a guide leaving it out gets a plain-word error from
 * `normalize`.
 */
const ManualCheck = Schema.Struct({
  /** How to get the change running, from the repository's README, scripts or docs. */
  setup: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        action: Schema.String,
        expect: Schema.String,
        /** What is most likely to go wrong in this step. */
        watchFor: Schema.optionalKey(Schema.String),
        /** The chapter whose code the step exercises. */
        chapter: Schema.optionalKey(ChapterReference),
      }),
    ),
  ),
  reason: Schema.optionalKey(Schema.String),
});

const GuideChapter = Schema.Struct({ ...chapterFields, files: Schema.Array(FileEntry) });

export const Guide = Schema.Struct({
  summary: Paragraphs,
  background: Schema.optionalKey(Paragraphs),
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
  chapters: Schema.NonEmptyArray(GuideChapter),
  risk: Schema.optionalKey(PullRequestRisk),
  flow: Schema.optionalKey(Flow),
  focus: Schema.optionalKey(Focus),
  /** One entry per focus area the prompt lists, by its id. Leave out when it lists none. */
  focusAreas: Schema.optionalKey(FocusAreaAnswers),
  /** One advisory sentence on how conflicting guidance was resolved. Never treated as proof. */
  guidanceNote: Schema.optionalKey(Schema.String),
  preflight: Schema.optionalKey(Preflight),
  manualCheck: Schema.optionalKey(ManualCheck),
});
export type Guide = typeof Guide.Type;

/**
 * A guide while it is being written (`submit_draft`). Every field is optional: a
 * call sends what changed, and chapters merge by id. A chapter without files is
 * planned, and shows as a title until it is written.
 */
export const DraftGuide = Schema.Struct({
  summary: Schema.optionalKey(Paragraphs),
  background: Schema.optionalKey(Paragraphs),
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
  chapters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ ...chapterFields, files: Schema.optionalKey(Schema.Array(FileEntry)) }),
    ),
  ),
  risk: Schema.optionalKey(PullRequestRisk),
  flow: Schema.optionalKey(Flow),
  focus: Schema.optionalKey(Focus),
});
export type DraftGuide = typeof DraftGuide.Type;

/**
 * A fix to the guide `submit_guide` last rejected (`revise_guide`). Fields it sends
 * replace the rejected ones; a chapter replaces the one with its id, whole, or goes last.
 */
export const GuidePatch = Schema.Struct({
  summary: Schema.optionalKey(Paragraphs),
  background: Schema.optionalKey(Paragraphs),
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
  chapters: Schema.optionalKey(Schema.Array(GuideChapter)),
  risk: Schema.optionalKey(PullRequestRisk),
  flow: Schema.optionalKey(Flow),
  focus: Schema.optionalKey(Focus),
  focusAreas: Schema.optionalKey(FocusAreaAnswers),
  guidanceNote: Schema.optionalKey(Schema.String),
  preflight: Schema.optionalKey(Preflight),
  manualCheck: Schema.optionalKey(ManualCheck),
});
export type GuidePatch = typeof GuidePatch.Type;

const NormalizedCallout = Schema.Struct({ tone: GuideTone, text: Schema.String });
const PreflightPlace = { chapter: Schema.String, at: Schema.NullOr(DiffLineRef) };
export const NormalizedPreflight = Schema.Struct({
  questions: Schema.Array(Schema.Struct({ text: Schema.String, ...PreflightPlace })),
  description: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("missing-from-description"),
        text: Schema.String,
        ...PreflightPlace,
      }),
      Schema.Struct({
        kind: Schema.Literal("missing-from-code"),
        text: Schema.String,
        quote: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal("differs"),
        text: Schema.String,
        quote: Schema.String,
        ...PreflightPlace,
      }),
    ]),
  ),
  tests: Schema.Array(
    Schema.Struct({ text: Schema.String, path: Schema.String, line: Schema.NullOr(Schema.Int) }),
  ),
});
export type NormalizedPreflight = typeof NormalizedPreflight.Type;
export const ManualCheckStep = Schema.Struct({
  /** Inline markdown, like every text below. */
  action: Schema.String,
  expect: Schema.String,
  watchFor: Schema.NullOr(Schema.String),
  chapter: Schema.NullOr(Schema.String),
});
export type ManualCheckStep = typeof ManualCheckStep.Type;
/** Steps to see the change working, or why there is nothing to check by hand. */
export const NormalizedManualCheck = Schema.Union([
  Schema.TaggedStruct("steps", {
    setup: Schema.NullOr(Schema.String),
    steps: Schema.NonEmptyArray(ManualCheckStep),
  }),
  Schema.TaggedStruct("nothing", { reason: Schema.String }),
]);
export type NormalizedManualCheck = typeof NormalizedManualCheck.Type;
const NormalizedFlowGraph = Schema.Struct({
  _tag: Schema.Literal("graph").pipe(Schema.withDecodingDefaultKey(Effect.succeed("graph"))),
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
  direction: GuideFlowDirection,
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      status: GuideFlowStatus,
      chapter: Schema.NullOr(Schema.String),
      detail: Schema.NullOr(Schema.String),
    }),
  ),
  edges: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      label: Schema.NullOr(Schema.String),
      status: GuideFlowStatus,
    }),
  ),
});
const NormalizedBehaviorDiff = Schema.TaggedStruct("behavior", {
  title: Schema.String,
  subtitle: Schema.NullOr(Schema.String),
  /** Reading order. The first row is at depth 0 and each row is at most one deeper than the row above. */
  rows: Schema.Array(
    Schema.Struct({
      status: GuideRowStatus,
      /** Inline markdown, one short line. */
      text: Schema.String,
      depth: GuideRowDepth,
      /** A new-side line inside a hunk of a text diff. */
      at: DiffLineRef,
      chapter: Schema.NullOr(Schema.String),
    }),
  ),
});
export const NormalizedGuide = Schema.Struct({
  summary: Schema.Array(Schema.String),
  background: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.String),
  chapters: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      kind: GuideKind,
      body: Schema.Array(Schema.String),
      pseudocode: Schema.NullOr(Schema.String),
      callouts: Schema.Array(NormalizedCallout),
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          note: Schema.NullOr(Schema.String),
          collapsed: Schema.Boolean,
          annotations: Schema.Array(
            Schema.Struct({
              line: Schema.Int,
              side: GuideSide,
              tone: GuideTone,
              text: Schema.String,
            }),
          ),
        }),
      ),
      /** Null on prkit's skipped chapter and in revisions written before risk. */
      risk: Schema.NullOr(
        Schema.Struct({
          level: RiskLevel,
          reasons: Schema.Array(
            Schema.Struct({
              text: Schema.String,
              file: Schema.String,
              line: Schema.NullOr(Schema.Int),
            }),
          ),
        }),
      ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    }),
  ),
  /** Null in revisions written before risk, and while a draft has no level yet. */
  risk: Schema.NullOr(
    Schema.Struct({
      level: RiskLevel,
      reasons: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          /** Null only in a streamed draft, until its chapter is written. */
          chapter: Schema.NullOr(Schema.String),
          at: Schema.NullOr(DiffLineRef),
        }),
      ),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** prkit's facts about the reviewed files, frozen with the attempt. Never the agent's. */
  signals: Schema.Array(RiskSignal).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  flow: Schema.NullOr(Schema.Union([NormalizedFlowGraph, NormalizedBehaviorDiff])),
  focus: Schema.Array(
    Schema.Struct({
      tone: GuideTone,
      text: Schema.String,
      chapter: Schema.NullOr(Schema.String),
    }),
  ),
  /** Revisions written before focus areas existed decode with none. */
  focusAreas: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      question: Schema.String,
      verdict: FocusVerdict,
      text: Schema.String,
      chapter: Schema.NullOr(Schema.String),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  guidanceNote: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** Only on a guide the author asked for. Revisions written before pre-flights decode with none. */
  preflight: Schema.NullOr(NormalizedPreflight).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** Null in drafts and in revisions written before manual checks. */
  manualCheck: Schema.NullOr(NormalizedManualCheck).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
export type NormalizedGuide = typeof NormalizedGuide.Type;
