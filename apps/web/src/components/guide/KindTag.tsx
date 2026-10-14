import type { GuideChapter } from "./types";

const labels = {
  core: "Core",
  supporting: "Supporting",
  data: "Data",
  tests: "Tests",
  config: "Config",
  docs: "Docs",
  generated: "Generated",
};

export function KindTag({ kind }: Pick<GuideChapter, "kind">) {
  return (
    <span data-kind-tag="" data-kind={kind}>
      {labels[kind]}
    </span>
  );
}
