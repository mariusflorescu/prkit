import {
  type AccountId,
  GuideNotFoundError,
  type GuideRevision,
  indexTicks,
  ManualCheckCode,
  type ManualCheckDecision,
  type ManualCheckIndex,
  manualCheckCode,
  manualCheckDecided,
  manualCheckStepState,
  manualCheckStepVersion,
  ManualCheckTicks as Ticks,
  ManualCheckTicksError,
  type ManualCheckTicksChange,
  type PullRequestKey,
  type ReviewSubject,
  sortedCode,
  stepFiles,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { makeKeyedGate } from "../github/keyedGate.ts";
import { Reviews } from "../reviews/Reviews.ts";
import { subjectKey } from "../reviews/reviewSubject.ts";

const Row = Schema.Struct({
  step: Schema.String,
  code: Schema.String,
  ticked: Schema.Int,
  seq: Schema.Int,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeNext = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ next: Schema.Int })]));
const decodeTicks = Schema.decodeUnknownEffect(Ticks);
const CodeJson = Schema.fromJsonString(ManualCheckCode);
const decodeCode = Schema.decodeUnknownEffect(CodeJson);
const encodeCode = Schema.encodeEffect(CodeJson);
const readCode = (stored: string): Effect.Effect<ManualCheckCode | null, Schema.SchemaError> =>
  stored === "" ? Effect.succeed(null) : decodeCode(stored);

/**
 * The 1-based numbers of a revision's steps that are ticked, and of those ticked against code
 * that has changed since; none of either when it has no steps. The code is the revision's own.
 */
const stepNumbers = ({ normalized, snapshot }: GuideRevision, index: ManualCheckIndex) => {
  const plan = normalized.manualCheck;
  if (plan?._tag !== "steps") return { manualCheckTicked: [], manualCheckChanged: [] };
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const states = plan.steps.map((step) =>
    manualCheckStepState(
      manualCheckStepVersion(step),
      stepFiles(step, normalized.chapters, files),
      index,
    ),
  );
  const numbers = (wanted: (typeof states)[number]) =>
    states.flatMap((state, position) => (state === wanted ? [position + 1] : []));
  return { manualCheckTicked: numbers("ticked"), manualCheckChanged: numbers("changed") };
};

export class ManualCheckTicks extends Context.Service<
  ManualCheckTicks,
  Effect.Success<typeof make>
>()("@prkit/server/manualCheck/ManualCheckTicks") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reviews = yield* Reviews;
  const announced = yield* PubSub.unbounded<ManualCheckTicksChange>();
  /** One writer per subject, so a decision is read and written against the same ticks. */
  const withSubject = makeKeyedGate<string>(1);

  const storage =
    (subject: ReviewSubject, message: string) =>
    <A, R>(self: Effect.Effect<A, Schema.SchemaError | SqlError, R>) =>
      self.pipe(
        Effect.mapError(() => new ManualCheckTicksError({ subject, reason: "storage", message })),
      );

  const readTicks = (subject: ReviewSubject) =>
    Effect.gen(function* () {
      const rows = yield* sql`
        SELECT step, code, ticked, seq FROM manual_check_ticks
        WHERE subject = ${subjectKey(subject)} ORDER BY seq DESC, step, code`.pipe(
        Effect.flatMap(decodeRows),
      );
      const ticks = yield* Effect.forEach(rows, (row) =>
        readCode(row.code).pipe(
          Effect.map((code) => ({
            step: row.step,
            code,
            ticked: row.ticked === 1,
            order: row.seq,
          })),
        ),
      );
      return yield* decodeTicks({ ticks });
    });

  const ticks = (subject: ReviewSubject) =>
    readTicks(subject).pipe(storage(subject, "prkit couldn't read your ticks. Try again."));

  /** Tells every window to read this subject's ticks again; call it after the write is saved. */
  const announceChanged = (subject: ReviewSubject) =>
    PubSub.publish(announced, { _tag: "changed", subject });

  /**
   * Records what the reader decided about these step versions, against the code each was made
   * for. A decision the newest answer about the same code already holds changes nothing, its
   * order included, so repeating one is safe.
   */
  const decide = (subject: ReviewSubject, decision: ManualCheckDecision) =>
    withSubject(
      subjectKey(subject),
      Effect.gen(function* () {
        const key = subjectKey(subject);
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const index = indexTicks(yield* readTicks(subject));
            const at = DateTime.formatIso(yield* DateTime.now);
            const [{ next }] = yield* sql`
              SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM manual_check_ticks`.pipe(
              Effect.flatMap(decodeNext),
            );
            let changed = false;
            for (const entry of decision.steps) {
              const code = entry.code === null ? null : sortedCode(entry.code);
              const decided = manualCheckDecided(index.get(entry.step) ?? [], code ?? []);
              if (decided?.compared === "same" && decided.tick.ticked === decision.ticked) continue;
              const stored = code === null ? "" : yield* encodeCode(code);
              yield* sql`
                INSERT INTO manual_check_ticks (subject, step, code, ticked, seq, decided_at)
                VALUES (${key}, ${entry.step}, ${stored}, ${decision.ticked ? 1 : 0}, ${next}, ${at})
                ON CONFLICT (subject, step, code)
                DO UPDATE SET ticked = excluded.ticked, seq = excluded.seq, decided_at = excluded.decided_at`;
              changed = true;
            }
            return changed;
          }),
        );
        if (changed) yield* announceChanged(subject);
        return yield* readTicks(subject);
      }).pipe(storage(subject, "prkit couldn't save your tick. Try again.")),
    );

  /** Open while a window is: first `connected`, then one `changed` per saved decision. */
  const changes = (): Stream.Stream<ManualCheckTicksChange> =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before announcing, so nothing saved in between is lost.
        const subscription = yield* PubSub.subscribe(announced);
        const connected: ManualCheckTicksChange = { _tag: "connected" };
        return Stream.concat(Stream.succeed(connected), Stream.fromSubscription(subscription));
      }),
    );

  /**
   * Which of a revision's steps the reader ticked and which have changed since, for outside
   * readers of the guide, from one read of the ticks.
   */
  const numbers = (subject: ReviewSubject, revision: GuideRevision) =>
    ticks(subject).pipe(Effect.map((all) => stepNumbers(revision, indexTicks(all))));

  /**
   * An outside write: steps of one accepted revision, by number, ticked or unticked in one
   * decision. A revision whose review is bound to another account is refused, so one account
   * never reads another's private code.
   */
  const tickSteps = (
    target: { readonly key: PullRequestKey; readonly accountId: AccountId },
    revision: number,
    picked: ReadonlyArray<number>,
    tick: boolean,
  ) =>
    Effect.gen(function* () {
      const subject: ReviewSubject = { _tag: "pull-request", ...target };
      const bound = (yield* reviews.get(target.key)).review;
      if (bound !== null && bound.accountId !== target.accountId)
        return yield* new GuideNotFoundError({
          key: target.key,
          message: `The guide for ${target.key} was written through ${bound.accountId}, not ${target.accountId}. Read it through that account.`,
        });
      const guide = yield* reviews.guide(target.key, revision);
      const plan = guide.normalized.manualCheck;
      const steps = plan?._tag === "steps" ? plan.steps : [];
      const files = new Map(guide.snapshot.files.map((file) => [file.path, file]));
      const wanted = [...new Set(picked)];
      const missing = wanted.filter((number) => steps[number - 1] === undefined);
      const [first, ...rest] = wanted.flatMap((number) => {
        const step = steps[number - 1];
        return step === undefined
          ? []
          : [
              {
                step: manualCheckStepVersion(step),
                code: manualCheckCode(stepFiles(step, guide.normalized.chapters, files)),
              },
            ];
      });
      if (missing.length > 0 || first === undefined)
        return yield* new ManualCheckTicksError({
          subject,
          reason: "no-such-step",
          message:
            steps.length === 0
              ? `Revision ${revision} of the guide for ${target.key} has no manual check steps.`
              : `Revision ${revision} has steps 1-${steps.length}, not ${missing.join(", ")}. Read them with read_guide_revision.`,
        });
      const after = yield* decide(subject, { steps: [first, ...rest], ticked: tick });
      return { revision, ticked: stepNumbers(guide, indexTicks(after)).manualCheckTicked };
    });

  return { ticks, decide, announceChanged, changes, numbers, tickSteps };
});

export const layer = Layer.effect(ManualCheckTicks, make);
