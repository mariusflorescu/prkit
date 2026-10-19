import {
  type AccountId,
  GuideNotFoundError,
  type ManualCheckDecision,
  ManualCheckTicks as Ticks,
  ManualCheckTicksError,
  type ManualCheckTicksChange,
  manualCheckStepVersion,
  type NormalizedGuide,
  type PullRequestKey,
  type ReviewSubject,
  tickedSteps,
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

const Row = Schema.Struct({ step: Schema.String, ticked: Schema.Int, seq: Schema.Int });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const decodeNext = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ next: Schema.Int })]));
const decodeTicks = Schema.decodeUnknownEffect(Ticks);

/** The 1-based numbers of a guide's steps that are ticked; none when it has no steps. */
const tickedNumbers = (guide: NormalizedGuide, ticks: Ticks) => {
  const plan = guide.manualCheck;
  if (plan?._tag !== "steps") return [];
  const ticked = tickedSteps(ticks);
  return plan.steps.flatMap((step, index) =>
    ticked.has(manualCheckStepVersion(step)) ? [index + 1] : [],
  );
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
        SELECT step, ticked, seq FROM manual_check_ticks
        WHERE subject = ${subjectKey(subject)} ORDER BY seq DESC, step`.pipe(
        Effect.flatMap(decodeRows),
      );
      return yield* decodeTicks({
        ticks: rows.map((row) => ({ step: row.step, ticked: row.ticked === 1, order: row.seq })),
      });
    });

  const ticks = (subject: ReviewSubject) =>
    readTicks(subject).pipe(storage(subject, "prkit couldn't read your ticks. Try again."));

  /** Tells every window to read this subject's ticks again; call it after the write is saved. */
  const announceChanged = (subject: ReviewSubject) =>
    PubSub.publish(announced, { _tag: "changed", subject });

  /**
   * Records what the reader decided about these step versions. A decision a version already
   * holds changes nothing, its order included, so repeating one is safe.
   */
  const decide = (subject: ReviewSubject, decision: ManualCheckDecision) =>
    withSubject(
      subjectKey(subject),
      Effect.gen(function* () {
        const key = subjectKey(subject);
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const held = new Map(
              (yield* readTicks(subject)).ticks.map((tick) => [tick.step, tick.ticked]),
            );
            const at = DateTime.formatIso(yield* DateTime.now);
            const [{ next }] = yield* sql`
              SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM manual_check_ticks`.pipe(
              Effect.flatMap(decodeNext),
            );
            let changed = false;
            for (const step of new Set(decision.steps)) {
              if (held.get(step) === decision.ticked) continue;
              yield* sql`
                INSERT INTO manual_check_ticks (subject, step, ticked, seq, decided_at)
                VALUES (${key}, ${step}, ${decision.ticked ? 1 : 0}, ${next}, ${at})
                ON CONFLICT (subject, step)
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

  /** Which of a guide's steps the reader ticked, for outside readers of the guide. */
  const ticked = (subject: ReviewSubject, guide: NormalizedGuide) =>
    ticks(subject).pipe(Effect.map((all) => tickedNumbers(guide, all)));

  /**
   * An outside write: steps of one accepted revision, by number, ticked or unticked in one
   * decision. A revision whose review is bound to another account is refused, so one account
   * never reads another's private code.
   */
  const tickSteps = (
    target: { readonly key: PullRequestKey; readonly accountId: AccountId },
    revision: number,
    numbers: ReadonlyArray<number>,
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
      const wanted = [...new Set(numbers)];
      const missing = wanted.filter((number) => steps[number - 1] === undefined);
      const [first, ...rest] = wanted.flatMap((number) => {
        const step = steps[number - 1];
        return step === undefined ? [] : [manualCheckStepVersion(step)];
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
      return { revision, ticked: tickedNumbers(guide.normalized, after) };
    });

  return { ticks, decide, announceChanged, changes, ticked, tickSteps };
});

export const layer = Layer.effect(ManualCheckTicks, make);
