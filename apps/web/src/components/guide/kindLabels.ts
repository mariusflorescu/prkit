import type { GuideChapter } from "./types";

export const kindLabels = {
  core: "Core",
  supporting: "Supporting",
  data: "Data",
  tests: "Tests",
  config: "Config",
  docs: "Docs",
  generated: "Generated",
} as const satisfies Record<GuideChapter["kind"], string>;
