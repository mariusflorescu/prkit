import type { Guide, ManualCheckStep, NormalizedGuide } from "./guide.ts";
import { type Report, resolveChapter, trim, words } from "./guideCheck.ts";
import { manualCheckStepVersion } from "./manualCheckTicks.ts";

/** A plan longer than this stops being something a person runs through before merging. */
export const MANUAL_CHECK_STEPS_MAX = 5;
const ACTION_WORDS_MAX = 40;
const EXPECT_WORDS_MAX = 30;
const WATCH_WORDS_MAX = 25;
const SETUP_WORDS_MAX = 40;
const REASON_WORDS_MAX = 25;

const SHAPE =
  '{"steps": [{"action": "...", "expect": "...", "watchFor": "...", "chapter": "<chapter id>"}]}';

const tooLong = (text: string, max: number, where: string, report: Report) => {
  const count = words(text);
  if (count > max)
    report.warnings.push(`${where} is ${count} words. Keep it to one short sentence, under ${max}.`);
};

const normalizeStep = (
  raw: NonNullable<NonNullable<Guide["manualCheck"]>["steps"]>[number],
  index: number,
  chapterIds: ReadonlyArray<string>,
  report: Report,
): ManualCheckStep => {
  const where = `\`manualCheck\` step ${index + 1}`;
  const action = trim(raw.action);
  const expect = trim(raw.expect);
  const watchFor = trim(raw.watchFor ?? "");
  if (action === "")
    report.errors.push(
      `${where} has no \`action\`. Say in one sentence what to do: what to open, run, click or send.`,
    );
  else tooLong(action, ACTION_WORDS_MAX, `${where} \`action\``, report);
  if (expect === "")
    report.errors.push(
      `${where} has no \`expect\`. Say what they should see when it works: a page, a status code, a number, a message.`,
    );
  else tooLong(expect, EXPECT_WORDS_MAX, `${where} \`expect\``, report);
  tooLong(watchFor, WATCH_WORDS_MAX, `${where} \`watchFor\``, report);
  return {
    action,
    expect,
    watchFor: watchFor === "" ? null : watchFor,
    chapter: resolveChapter(raw.chapter, chapterIds, where, report),
  };
};

/**
 * Checks the agent's manual check plan and points each step at a written chapter. A
 * finished guide must have one when the attempt checks it against its settings; a draft
 * never shows one. `chapterIds` are the agent's own, so no step can name prkit's skipped
 * chapter.
 */
export const normalizeManualCheck = (input: {
  readonly raw: Guide["manualCheck"];
  readonly chapterIds: ReadonlyArray<string>;
  readonly required: boolean;
  readonly report: Report;
}): NormalizedGuide["manualCheck"] => {
  const { raw, chapterIds, required, report } = input;
  if (raw === undefined) {
    if (required)
      report.errors.push(
        `\`manualCheck\` is missing. Say how a person can see this change working by hand: ${SHAPE}. When there is nothing to check by hand, send {"steps": [], "reason": "..."}.`,
      );
    return null;
  }
  const setup = trim(raw.setup ?? "");
  const reason = trim(raw.reason ?? "");
  const steps = (raw.steps ?? []).map((step, index) =>
    normalizeStep(step, index, chapterIds, report),
  );
  if (steps.length > MANUAL_CHECK_STEPS_MAX)
    report.errors.push(
      `\`manualCheck\` has ${steps.length} steps. Keep the ${MANUAL_CHECK_STEPS_MAX} or fewer that show the change working, the most telling first.`,
    );
  const seen = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (step.action === "" || step.expect === "") continue;
    const version = manualCheckStepVersion(step);
    const first = seen.get(version);
    if (first === undefined) seen.set(version, index);
    else
      report.errors.push(
        `\`manualCheck\` step ${index + 1} is the same check as step ${first + 1}. Drop one, or make them check different things.`,
      );
  }
  const [first, ...rest] = steps;
  if (first === undefined) {
    if (reason === "")
      report.errors.push(
        '`manualCheck` has no steps and no `reason`. When there is nothing to check by hand, say why in one short sentence: "Only renames `parseUrl` to `parseLink`, so nothing behaves differently."',
      );
    if (setup !== "")
      report.errors.push(
        "`manualCheck.setup` only goes with steps. Leave it out when there is nothing to check by hand.",
      );
    tooLong(reason, REASON_WORDS_MAX, "`manualCheck.reason`", report);
    return { _tag: "nothing", reason };
  }
  if (reason !== "")
    report.errors.push(
      "`manualCheck` has steps and a `reason`. `reason` is only for a change with nothing to check by hand, so leave it out.",
    );
  if (steps.every((step) => step.watchFor === null))
    report.errors.push(
      "No `manualCheck` step has a `watchFor`. Give one to the step where something is most likely to go wrong, and say what to watch for there.",
    );
  tooLong(setup, SETUP_WORDS_MAX, "`manualCheck.setup`", report);
  return { _tag: "steps", setup: setup === "" ? null : setup, steps: [first, ...rest] };
};

/** Every text of the plan, for the checks that read all of the guide's prose. */
export function* manualCheckTexts(check: NormalizedGuide["manualCheck"]) {
  if (check === null) return;
  if (check._tag === "nothing") {
    yield check.reason;
    return;
  }
  yield check.setup ?? "";
  for (const step of check.steps) {
    yield step.action;
    yield step.expect;
    yield step.watchFor ?? "";
  }
}
