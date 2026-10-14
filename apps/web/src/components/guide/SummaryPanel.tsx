import type { NormalizedGuide } from "@prkit/contracts";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { keyedItems } from "./keyedItems";

export function SummaryPanel({
  guide,
  prUrl,
}: {
  guide: NormalizedGuide;
  prUrl?: string | undefined;
}) {
  return (
    <section data-guide-summary="">
      <h2>Overview</h2>
      {keyedItems(guide.summary, (text) => text).map(({ key, value: text }) => (
        <p key={key}>
          <InlineMarkdown text={text} prUrl={prUrl} />
        </p>
      ))}
      {guide.background.length > 0 && (
        <details data-guide-background="">
          <summary>New to this code? Read the background</summary>
          <div>
            {keyedItems(guide.background, (text) => text).map(({ key, value: text }) => (
              <p key={key}>
                <InlineMarkdown text={text} prUrl={prUrl} />
              </p>
            ))}
          </div>
        </details>
      )}
      {guide.steps.length > 0 && (
        <ol>
          {keyedItems(guide.steps, (text) => text).map(({ key, value: text }) => (
            <li key={key}>
              <InlineMarkdown text={text} prUrl={prUrl} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
