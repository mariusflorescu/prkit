/**
 * The prompt's section asking for the author's pre-flight, and the log label for it. Only
 * a guide the change's own author reads gets one ("The author's pre-flight" in
 * instructions.md). `description` is the one the prompt quotes, "" when there is none.
 */
export const preflightLines = (description: string) => ({
  label: description === "" ? "preflight:no-description" : "preflight",
  lines: [
    'The account reading this guide opened this pull request, so the guide is for its own author. Add `preflight`, which only the author sees: what a reviewer will probably ask, where the description and the code disagree, and tests that look missing. "The author\'s pre-flight" in your instructions says how. Every point carries its evidence, and nothing to flag is a fine answer: send empty lists rather than padding them. Write `preflight` last, after everything else.',
    ...(description === ""
      ? [
          "The description is empty, so leave `preflight.description` out: prkit offers to write one from your guide.",
        ]
      : []),
    "",
  ],
});
