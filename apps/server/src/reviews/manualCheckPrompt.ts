import { MANUAL_CHECK_STEPS_MAX } from "@prkit/contracts";

/**
 * The prompt's section asking for the manual check plan, and the log label for it ("How to
 * check it" in instructions.md). It names no pull request, so a guide of local changes can
 * take it as it is.
 */
export const manualCheckLines = () => ({
  label: "manual-check",
  lines: [
    `Write \`manualCheck\` after the chapters: how a person sees this change working by hand, in up to ${MANUAL_CHECK_STEPS_MAX} steps, each with what to do and what they should see, and on the step most likely to go wrong, what to watch for. Learn how the project runs from the checkout's README, package scripts and docs. You can't run anything, so prkit shows the plan as your suggestion: never write that you ran or tested it. A change with nothing to check by hand, like a refactor, docs or tests alone, gets {"steps": [], "reason": "..."}. That is a real answer: never pad a plan. "How to check it" in your instructions says how.`,
    "",
  ],
});
