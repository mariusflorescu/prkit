import {
  AttemptConfig,
  AttemptId,
  checkContextOf,
  coverageProblems,
  DiffSnapshot,
  DraftGuide,
  type Guide,
  type GuidePatch,
  mergeDraft,
  NormalizedGuide,
  normalizeDraft,
  normalizeGuide,
  patchGuide,
  ReviewId,
  ReviewKey,
  reviewedSnapshot,
  withoutUnwrittenChapters,
  withSkippedChapter,
} from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OutlineChapters, plural, type ReviewStore } from "./reviewStore.ts";

export const SubmitGuideReceipt = Schema.Struct({
  message: Schema.String,
  chapters: Schema.Int,
  files: Schema.Int,
  warnings: Schema.Array(Schema.String),
});

export type SubmitGuideReceipt = typeof SubmitGuideReceipt.Type;

/** `submit_guide` failed; the message goes back to the agent as the tool result. */
export class SubmitGuideRejected extends Schema.TaggedError<SubmitGuideRejected>()(
  "SubmitGuideRejected",
  { message: Schema.String },
) {}

/** A second call in a turn that already handed prkit its guide, such as a parallel tool call. */
const ALREADY_STORED =
  "prkit already has this attempt's guide, so it won't use this one. End your turn now.";

const NO_LONGER_CURRENT =
  "This attempt is no longer current, so prkit won't use this guide. End your turn now.";

/** What `report_progress`, `note_file` and `submit_draft` answer the agent. */
export const ToolReceipt = Schema.Struct({ message: Schema.String });

export type ToolReceipt = typeof ToolReceipt.Type;

/** One of the progress tools refused the call; the message goes back to the agent. */
export class ToolRejected extends Schema.TaggedError<ToolRejected>()("ToolRejected", {
  message: Schema.String,
}) {}

const SubmitRow = Schema.Struct({
  review_id: ReviewId,
  pr_key: ReviewKey,
  current_attempt_id: Schema.NullOr(AttemptId),
  finished_at: Schema.NullOr(Schema.String),
  snapshot: Schema.NullOr(Schema.fromJsonString(DiffSnapshot)),
  draft: Schema.NullOr(Schema.fromJsonString(DraftGuide)),
  config: Schema.NullOr(Schema.fromJsonString(AttemptConfig)),
});

/** The attempt's guide once one passed, as stored. */
const CheckRow = Schema.Struct({ ...SubmitRow.fields, guide: Schema.NullOr(Schema.String) });

const decodeSubmit = Schema.decodeUnknownEffect(Schema.Array(SubmitRow));

const decodeCheck = Schema.decodeUnknownEffect(Schema.Array(CheckRow));

const decodeDraftOnly = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ draft: Schema.NullOr(Schema.fromJsonString(DraftGuide)) })),
);

const encodeGuide = Schema.encodeSync(Schema.fromJsonString(NormalizedGuide));

const encodeDraft = Schema.encodeSync(Schema.fromJsonString(DraftGuide));

const encodeOutline = Schema.encodeSync(Schema.fromJsonString(OutlineChapters));

/** One line, trimmed and cut to `max` characters, for what the agent reports. */
const clip = (text: string, max: number) => {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The tools the guide agent calls while it writes: progress, file notes, the draft, and the guide itself. */
export const makeGuideTools = ({
  sql,
  rejected,
  checking,
  publish,
  appendActivity,
  setPhase,
}: ReviewStore) => {
  /** The attempt a progress tool call speaks for, if it is still the one running. */
  const liveAttempt = (attemptId: AttemptId) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.review_id, r.pr_key, r.current_attempt_id, a.finished_at, a.snapshot, a.draft, a.config
        FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE a.id = ${attemptId}`.pipe(
        Effect.flatMap(decodeSubmit),
      );
      const row = rows[0];
      if (row === undefined || row.current_attempt_id !== attemptId || row.finished_at !== null)
        return yield* new ToolRejected({
          message:
            "This attempt is no longer current, so prkit ignored the call. End your turn now.",
        });
      return row;
    });

  const toolFailures = {
    SqlError: () =>
      Effect.fail(new ToolRejected({ message: "prkit couldn't save that. Call the tool again." })),
    SchemaError: () =>
      Effect.fail(
        new ToolRejected({ message: "prkit couldn't read this attempt. Call the tool again." }),
      ),
  };

  /** `report_progress`: the one line the reviewer sees about what the agent is doing now. */
  const reportProgress = (attemptId: AttemptId, message: string) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      const line = clip(message, 160);
      if (line === "")
        return yield* new ToolRejected({
          message: "Send one short line about what you are doing.",
        });
      yield* sql`UPDATE review_attempts SET narration = ${line} WHERE id = ${attemptId} AND finished_at IS NULL`;
      yield* publish(row.pr_key);
      return { message: "The reviewer sees it. Keep going." } satisfies ToolReceipt;
    }).pipe(Effect.catchTags(toolFailures));

  /** `note_file`: one line about a changed file, shown next to it while the guide is written. */
  const noteFile = (attemptId: AttemptId, filePath: string, note: string) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      const line = clip(note, 240);
      if (line === "")
        return yield* new ToolRejected({
          message: "Send one plain line about what the file changes.",
        });
      const updated = yield* sql`
        UPDATE review_attempt_files SET note = ${line}
        WHERE attempt_id = ${attemptId} AND path = ${filePath} RETURNING path`;
      if (updated.length === 0)
        return yield* new ToolRejected({
          message: `\`${filePath}\` isn't one of this diff's changed files. Use the path exactly as the diff lists it.`,
        });
      yield* publish(row.pr_key);
      return { message: "Noted." } satisfies ToolReceipt;
    }).pipe(Effect.catchTags(toolFailures));

  /** Keeps a checked draft as the attempt's latest, for the reviewer to read now. */
  const keepDraft = (attemptId: AttemptId, draft: DraftGuide, normalized: NormalizedGuide) =>
    Effect.gen(function* () {
      const outline = normalized.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        written: chapter.files.length > 0,
      }));
      yield* sql`
        UPDATE review_attempts SET draft = ${encodeDraft(draft)}, draft_outline = ${encodeOutline(outline)},
          draft_version = draft_version + 1
        WHERE id = ${attemptId} AND finished_at IS NULL`;
      return outline;
    });

  /**
   * `submit_draft`: merges the call into the draft so far and keeps it when every
   * reference resolves. A draft is for reading early; only `submit_guide` makes a revision.
   */
  const submitDraft = (attemptId: AttemptId, input: DraftGuide) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      if (row.snapshot === null || row.config === null)
        return yield* new ToolRejected({ message: "The diff isn't ready yet. Try again shortly." });
      const merged = mergeDraft(row.draft, input);
      const result = normalizeDraft(
        merged,
        reviewedSnapshot(row.snapshot, row.config.skipped),
        checkContextOf(row.config),
      );
      if (result.normalized === null)
        return yield* new ToolRejected({
          message: `The draft has ${plural(result.errors.length, "problem")}. Fix ${result.errors.length === 1 ? "it" : "them"} and send the draft again:\n- ${result.errors.join("\n- ")}`,
        });
      const outline = yield* keepDraft(attemptId, merged, result.normalized);
      yield* setPhase(row.pr_key, row.review_id, attemptId, "writing-guide");
      yield* publish(row.pr_key);
      const written = outline.filter((chapter) => chapter.written).length;
      return {
        message: `Draft saved: the overview${outline.length === 0 ? "" : ` and ${written} of ${plural(outline.length, "chapter")} written`}. Send each chapter with submit_draft as you finish it, then the complete guide with submit_guide.`,
      } satisfies ToolReceipt;
    }).pipe(Effect.catchTags(toolFailures));

  /**
   * One finished piece of a `submit_guide` call the agent is still writing: a field
   * or a chapter. It joins the draft the way a `submit_draft` call would, except that
   * a reference to a chapter not written yet waits instead of failing. A piece that
   * doesn't pass is left out, so the reviewer keeps the last good draft; the call's
   * own check tells the agent what was wrong.
   */
  const streamDraft = (attemptId: AttemptId, piece: DraftGuide) =>
    Effect.gen(function* () {
      const row = yield* liveAttempt(attemptId);
      if (row.snapshot === null || row.config === null) return;
      const merged = mergeDraft(row.draft, piece);
      const result = normalizeDraft(
        withoutUnwrittenChapters(merged),
        reviewedSnapshot(row.snapshot, row.config.skipped),
        checkContextOf(row.config),
      );
      if (result.normalized === null)
        return yield* Effect.logInfo("Left a streamed guide piece out of the draft").pipe(
          Effect.annotateLogs({ problems: result.errors.length }),
        );
      yield* keepDraft(attemptId, merged, result.normalized);
      yield* publish(row.pr_key);
    }).pipe(
      Effect.catchTags({
        ToolRejected: () => Effect.void,
        SqlError: (error) => Effect.logWarning("Couldn't save the streamed draft", error),
        SchemaError: (error) => Effect.logWarning("Couldn't read the attempt's draft", error),
      }),
    );

  /** How many chapters the attempt's draft has, to tell a first `submit_guide` from a resubmission. */
  const draftChapters = (attemptId: AttemptId) =>
    sql`SELECT draft FROM review_attempts WHERE id = ${attemptId}`.pipe(
      Effect.flatMap(decodeDraftOnly),
      Effect.map((rows) => rows[0]?.draft?.chapters?.length ?? 0),
      Effect.catchTags({
        SqlError: () => Effect.succeed(0),
        SchemaError: () => Effect.succeed(0),
      }),
    );

  /** Checks a guide against the attempt's snapshot: a valid one is stored, a rejected one kept for `revise_guide`. */
  const checkGuide = (attemptId: AttemptId, input: Guide) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT a.review_id, r.pr_key, r.current_attempt_id, a.finished_at, a.snapshot, a.draft, a.config, a.guide
        FROM review_attempts a JOIN reviews r ON r.id = a.review_id WHERE a.id = ${attemptId}`.pipe(
        Effect.flatMap(decodeCheck),
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.current_attempt_id !== attemptId ||
        row.finished_at !== null ||
        row.snapshot === null ||
        row.config === null
      )
        return yield* new SubmitGuideRejected({ message: NO_LONGER_CURRENT });
      // The agent's guide covers the files it reviewed; prkit adds the skipped ones itself.
      const config = row.config;
      const result = normalizeGuide(
        input,
        reviewedSnapshot(row.snapshot, config.skipped),
        checkContextOf(config),
      );
      const warnings =
        result.warnings.length === 0
          ? ""
          : `\n\nWarnings (they don't block the guide):\n- ${result.warnings.join("\n- ")}`;
      const receipt = (normalized: NormalizedGuide): SubmitGuideReceipt => ({
        message: `prkit stored the guide.${warnings}\n\nEnd your turn now.`,
        chapters: normalized.chapters.length,
        files: normalized.chapters.reduce((count, chapter) => count + chapter.files.length, 0),
        warnings: [...result.warnings],
      });
      if (row.guide !== null) {
        // A call sent again because prkit failed after storing it gets its receipt again.
        if (
          result.normalized !== null &&
          encodeGuide(withSkippedChapter(result.normalized, config.skipped)) === row.guide
        )
          return receipt(result.normalized);
        return yield* new SubmitGuideRejected({ message: ALREADY_STORED });
      }
      yield* setPhase(row.pr_key, row.review_id, attemptId, "checking-guide");
      yield* Effect.logInfo("submit_guide validated").pipe(
        Effect.annotateLogs({
          attemptId,
          valid: result.normalized !== null,
          errors: result.errors.length,
          warnings: result.warnings.length,
        }),
      );
      if (result.normalized === null) {
        yield* Effect.logInfo("submit_guide rejected").pipe(
          Effect.annotateLogs({ attemptId, problems: result.errors.length }),
        );
        yield* appendActivity(
          row.pr_key,
          row.review_id,
          attemptId,
          "error",
          `The guide had ${plural(result.errors.length, "problem")}. The agent is fixing ${result.errors.length === 1 ? "it" : "them"}`,
        );
        yield* setPhase(row.pr_key, row.review_id, attemptId, "writing-guide");
        rejected.set(attemptId, input);
        return yield* new SubmitGuideRejected({
          message: `The guide has ${plural(result.errors.length, "problem")}. Fix all of them: call revise_guide with only the chapters and fields you change, each chapter whole with its id:\n- ${result.errors.join("\n- ")}${warnings}`,
        });
      }
      const normalized = result.normalized;
      const complete = withSkippedChapter(normalized, config.skipped);
      const gaps = coverageProblems(complete, row.snapshot);
      if (gaps.length > 0) {
        yield* Effect.logError("The accepted guide doesn't cover the full diff").pipe(
          Effect.annotateLogs({ attemptId, gaps }),
        );
        return yield* new SubmitGuideRejected({
          message: `prkit couldn't fit the guide to the full diff:\n- ${gaps.join("\n- ")}\nCall submit_guide again.`,
        });
      }
      const saved = yield* sql`
        UPDATE review_attempts SET guide = ${encodeGuide(complete)}
        WHERE id = ${attemptId} AND finished_at IS NULL RETURNING id`;
      if (saved.length === 0) return yield* new SubmitGuideRejected({ message: NO_LONGER_CURRENT });
      rejected.delete(attemptId);
      const shown = receipt(normalized);
      yield* appendActivity(
        row.pr_key,
        row.review_id,
        attemptId,
        "note",
        `The guide passed prkit's checks: ${plural(shown.chapters, "chapter")} cover ${plural(shown.files, "file")}`,
      );
      return shown;
    });

  const guideFailures = {
    SqlError: () =>
      Effect.fail(
        new SubmitGuideRejected({
          message: "prkit couldn't save the guide. Call submit_guide again.",
        }),
      ),
    SchemaError: () =>
      Effect.fail(
        new SubmitGuideRejected({
          message: "prkit couldn't read this attempt. Call submit_guide again.",
        }),
      ),
  };

  /** The `submit_guide` tool. */
  const submitGuide = (attemptId: AttemptId, input: Guide) =>
    checking(attemptId, checkGuide(attemptId, input)).pipe(Effect.catchTags(guideFailures));

  /** The `revise_guide` tool: the attempt's last rejected guide with the call applied, checked again. */
  const reviseGuide = (attemptId: AttemptId, patch: GuidePatch) =>
    checking(
      attemptId,
      Effect.gen(function* () {
        const last = rejected.get(attemptId);
        if (last === undefined)
          return yield* new SubmitGuideRejected({
            message:
              "prkit has no rejected guide from this attempt to revise. Call submit_guide with the whole guide.",
          });
        return yield* checkGuide(attemptId, patchGuide(last, patch));
      }),
    ).pipe(Effect.catchTags(guideFailures));

  return {
    reportProgress,
    noteFile,
    submitDraft,
    streamDraft,
    draftChapters,
    submitGuide,
    reviseGuide,
  };
};
