import { memo } from "react";
import Markdown, { type Components } from "react-markdown";

import { GuideLink } from "./GuideLink";
import { remarkPrReferences } from "./remarkPrReferences";

const components: Components = {
  p: "span",
  a: ({ href, children }) => <GuideLink href={href}>{children}</GuideLink>,
};
const elements = ["p", "code", "strong", "a"];

export const InlineMarkdown = memo(function InlineMarkdown({
  text,
  prUrl,
}: {
  text: string;
  prUrl?: string | undefined;
}) {
  return (
    <span data-guide-inline="">
      <Markdown
        components={components}
        allowedElements={elements}
        unwrapDisallowed
        skipHtml
        remarkPlugins={[[remarkPrReferences, { prUrl }]]}
      >
        {text}
      </Markdown>
    </span>
  );
});
