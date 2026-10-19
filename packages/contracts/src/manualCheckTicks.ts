import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";

import type { ManualCheckStep } from "./guide.ts";
import { ReviewSubject } from "./ids.ts";
import { compareVersions, FileVersion, fileVersion, type ReviewableFile } from "./reviewedFiles.ts";
import { fnv1a64 } from "./textHash.ts";

/**
 * The manual check steps the reader ticked (docs/internals/architecture.md "Manual checks").
 * Like a reviewed file, a tick belongs to a version of a step, not to a revision, so a new
 * revision keeps the tick on a step that reads the same and shows a reworded one unticked.
 * It also records the code its step exercised, the files of the step's chapter, so a step
 * whose code changed since the reader ticked it reads `changed`, like a reviewed file.
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

/**
 * What a step's chapter held when the reader decided: each file with its version, in path
 * order. A step with no chapter, or whose chapter has no file with a version, has no code (null).
 */
export const ManualCheckCode = Schema.NonEmptyArray(
  Schema.Struct({ path: Schema.String, version: FileVersion }),
).check(
  Schema.makeFilter(
    (code) =>
      new Set(code.map((file) => file.path)).size === code.length ||
      "A file can't appear twice in one code.",
  ),
);
export type ManualCheckCode = typeof ManualCheckCode.Type;

/** One decision about a step version made against some code. `order` grows with every saved decision. */
export const ManualCheckTick = Schema.Struct({
  step: ManualCheckStepVersion,
  code: Schema.NullOr(ManualCheckCode),
  ticked: Schema.Boolean,
  order: Schema.Int,
});
export type ManualCheckTick = typeof ManualCheckTick.Type;

export const ManualCheckTicks = Schema.Struct({ ticks: Schema.Array(ManualCheckTick) });
export type ManualCheckTicks = typeof ManualCheckTicks.Type;

/** Ticks or unticks these versions. Setting, never toggling, so a retry changes nothing. */
export const ManualCheckDecision = Schema.Struct({
  steps: Schema.NonEmptyArray(
    Schema.Struct({ step: ManualCheckStepVersion, code: Schema.NullOr(ManualCheckCode) }),
  ),
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

/**
 * `changed` is a step whose newest decision about code known to differ ticked it, so it
 * shows unticked with a note and needs another look.
 */
export const ManualCheckStepState = Schema.Literals(["ticked", "changed", "unticked"]);
export type ManualCheckStepState = typeof ManualCheckStepState.Type;

/** A file of the chapter a step exercises, with its version in one revision. */
export type StepFile = {
  readonly path: string;
  /** Where a renamed file came from. */
  readonly previousPath?: string | undefined;
  readonly version: FileVersion;
};

const byPath = Order.mapInput(Order.String, (file: { readonly path: string }) => file.path);

/** The one order of a code, so the same chapter always makes the same key. */
export const sortedCode = (code: ManualCheckCode): ManualCheckCode => Arr.sort(byPath)(code);

/**
 * The files the step's chapter lists in one revision's snapshot. Files the snapshot lacks, or
 * that have no version, are left out, and so is a step with no chapter.
 */
export const stepFiles = (
  step: Pick<ManualCheckStep, "chapter">,
  chapters: ReadonlyArray<{
    readonly id: string;
    readonly files: ReadonlyArray<{ readonly path: string }>;
  }>,
  files: ReadonlyMap<string, ReviewableFile>,
): ReadonlyArray<StepFile> => {
  const listed = chapters.find((chapter) => chapter.id === step.chapter)?.files ?? [];
  return [...new Set(listed.map((entry) => entry.path))].flatMap((path) => {
    const file = files.get(path);
    const version = file === undefined ? null : fileVersion(file);
    if (file === undefined || version === null) return [];
    return file.status === "renamed" && file.previousPath !== null
      ? [{ path, previousPath: file.previousPath, version }]
      : [{ path, version }];
  });
};

/** The one way to build what a decision records: null when the step has no code. */
export const manualCheckCode = (files: ReadonlyArray<StepFile>): ManualCheckCode | null => {
  const [first, ...rest] = files.map(({ path, version }) => ({ path, version }));
  return first === undefined ? null : sortedCode([first, ...rest]);
};

/**
 * Whether the code a decision was made against reads the same as the files now. Only files
 * in both count, matched by path or, for a renamed file, by the path it came from, and each
 * by its hunks as `compareVersions` does, so a base merge that only moves lines is the same
 * code and a file moved into the chapter without a change counts for nothing.
 */
export const compareCode = (
  then: ManualCheckCode,
  now: ReadonlyArray<StepFile>,
): "same" | "different" | "unknown" => {
  const before = new Map(then.map((file) => [file.path, file.version]));
  const compared = now.flatMap((file) => {
    const was =
      before.get(file.path) ??
      (file.previousPath === undefined ? undefined : before.get(file.previousPath));
    return was === undefined ? [] : [compareVersions(was, file.version)];
  });
  return compared.some((result) => result === "different")
    ? "different"
    : compared.some((result) => result === "same")
      ? "same"
      : "unknown";
};

/** Newest first per step version. Built once per ticks value. */
export type ManualCheckIndex = ReadonlyMap<ManualCheckStepVersion, ReadonlyArray<ManualCheckTick>>;

export const indexTicks = ({ ticks }: ManualCheckTicks): ManualCheckIndex => {
  const index = new Map<ManualCheckStepVersion, Array<ManualCheckTick>>();
  for (const tick of ticks) {
    const list = index.get(tick.step);
    if (list === undefined) index.set(tick.step, [tick]);
    else list.push(tick);
  }
  for (const list of index.values()) list.sort((a, b) => b.order - a.order);
  return index;
};

/**
 * The decision that answers for a step against its code now: the newest one made against
 * the same code, else the newest made against code that differs, else the newest, whose code
 * can't be compared (a tick stored before ticks kept code, or sharing no file with it). A step
 * with no code now follows its newest decision alone.
 */
export const manualCheckDecided = (
  decisions: ReadonlyArray<ManualCheckTick>,
  now: ReadonlyArray<StepFile>,
):
  | { readonly tick: ManualCheckTick; readonly compared: "same" | "different" | "unknown" }
  | undefined => {
  if (now.length === 0) {
    const [tick] = decisions;
    return tick === undefined ? undefined : { tick, compared: "same" };
  }
  const compared = decisions.map((tick) => ({
    tick,
    compared: tick.code === null ? ("unknown" as const) : compareCode(tick.code, now),
  }));
  return (
    compared.find((entry) => entry.compared === "same") ??
    compared.find((entry) => entry.compared === "different") ??
    compared[0]
  );
};

export const manualCheckStepState = (
  step: ManualCheckStepVersion,
  now: ReadonlyArray<StepFile>,
  index: ManualCheckIndex,
): ManualCheckStepState => {
  const decided = manualCheckDecided(index.get(step) ?? [], now);
  if (decided === undefined || !decided.tick.ticked) return "unticked";
  return decided.compared === "different" ? "changed" : "ticked";
};
