import { kindLabels } from "./kindLabels";
import type { GuideChapter } from "./types";

export function KindTag({ kind }: Pick<GuideChapter, "kind">) {
  return (
    <span data-kind-tag="" data-kind={kind}>
      {kindLabels[kind]}
    </span>
  );
}
