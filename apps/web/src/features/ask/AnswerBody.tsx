import type { AnswerPart } from "@prkit/contracts";

import { AnswerMarkdown } from "./AnswerMarkdown";
import { answerBlocks } from "./askPresentation";

/** Every text part of an answer in order, and each run of the agent's tool calls as one muted line. */
export function AnswerBody({
  parts,
  files,
  onLine,
}: {
  parts: ReadonlyArray<AnswerPart>;
  files: ReadonlySet<string>;
  onLine: (path: string, line: number) => void;
}) {
  return answerBlocks(parts).map((block) =>
    block._tag === "text" ? (
      <AnswerMarkdown key={block.start} text={block.text} files={files} onLine={onLine} />
    ) : (
      <p key={block.start} className="text-xs text-muted-foreground">
        {block.labels.join(" · ")}
      </p>
    ),
  );
}
