import * as Schema from "effect/Schema";

import type { ManualCheckStep } from "./guide.ts";
import { ReviewSubject } from "./ids.ts";
import { fnv1a64 } from "./textHash.ts";

/**
 * The manual check steps the reader ticked (docs/internals/architecture.md "Manual checks").
 * Like a reviewed file, a tick belongs to a version of a step, not to a revision, so a new
 * revision keeps the tick on a step that reads the same and shows a reworded one unticked.
 */

/** FNV-1a of what the step asks and what it expects, with runs of whitespace collapsed. */
export const ManualCheckStepVersion = Schema.NonEmptyString.pipe(
  Schema.brand("ManualCheckStepVersion"),
);
export type ManualCheckStepVersion = typeof ManualCheckStepVersion.Type;

const oneLine = (text: string) => text.split(/\s+/u).filter(Boolean).join(" ");

/** The same check whatever its caution or chapter, which can change while the check stays. */
export const manualCheckStepVersion = (step: Pick<ManualCheckStep, "action" | "expect">) =>
  ManualCheckStepVersion.make(fnv1a64(`${oneLine(step.action)}\n${oneLine(step.expect)}`));

/** One version's current answer. `order` grows with every saved decision. */
export const ManualCheckTick = Schema.Struct({
  step: ManualCheckStepVersion,
  ticked: Schema.Boolean,
  order: Schema.Int,
});
export type ManualCheckTick = typeof ManualCheckTick.Type;

export const ManualCheckTicks = Schema.Struct({ ticks: Schema.Array(ManualCheckTick) });
export type ManualCheckTicks = typeof ManualCheckTicks.Type;

/** Ticks or unticks these versions. Setting, never toggling, so a retry changes nothing. */
export const ManualCheckDecision = Schema.Struct({
  steps: Schema.NonEmptyArray(ManualCheckStepVersion),
  ticked: Schema.Boolean,
});
export type ManualCheckDecision = typeof ManualCheckDecision.Type;

/** `connected` once the subscription is live, then one `changed` per saved decision. */
export const ManualCheckTicksChange = Schema.Union([
  Schema.TaggedStruct("connected", {}),
  Schema.TaggedStruct("changed", { subject: ReviewSubject }),
]);
export type ManualCheckTicksChange = typeof ManualCheckTicksChange.Type;

export class ManualCheckTicksError extends Schema.TaggedError<ManualCheckTicksError>()(
  "ManualCheckTicksError",
  {
    subject: ReviewSubject,
    reason: Schema.Literals(["storage", "no-such-step"]),
    message: Schema.String,
  },
) {}

export const tickedSteps = ({ ticks }: ManualCheckTicks): ReadonlySet<ManualCheckStepVersion> =>
  new Set(ticks.flatMap((tick) => (tick.ticked ? [tick.step] : [])));
