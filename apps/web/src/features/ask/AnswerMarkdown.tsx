import { memo, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { parseCodeRef, remarkCodeRefs } from "./remarkCodeRefs";

const components: Components = {
  img: ({ alt }) => alt ?? "",
  a: ({ href, children }) =>
    parseCodeRef(href) === null ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <a href={href} data-code-ref="" title="Show this line in the diff">
        {children}
      </a>
    ),
};

/**
 * An answer in full GFM, with tags shown as the agent wrote them (a `<T>` it names stays) and
 * `path:line` references to `files` linked to that line of the guide's diff.
 */
export const AnswerMarkdown = memo(function AnswerMarkdown({
  text,
  files,
  onLine,
}: {
  text: string;
  files: ReadonlySet<string>;
  onLine: (path: string, line: number) => void;
}) {
  const open = (event: MouseEvent<HTMLDivElement>) => {
    const link = event.target instanceof Element ? event.target.closest("a[data-code-ref]") : null;
    const ref = parseCodeRef(link?.getAttribute("href") ?? undefined);
    if (ref === null) return;
    event.preventDefault();
    onLine(ref.path, ref.line);
  };
  return (
    <div className="pr-markdown" onClick={open}>
      <Markdown remarkPlugins={[remarkGfm, [remarkCodeRefs, { files }]]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
