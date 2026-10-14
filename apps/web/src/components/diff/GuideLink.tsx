import { type ReactNode, useContext } from "react";

import { StackLinksContext } from "./stackLinks";

/** A link in guide text. A stack layer's `#123` opens its Guide tab; anything else opens GitHub. */
export function GuideLink({ href, children }: { href?: string | undefined; children: ReactNode }) {
  const stack = useContext(StackLinksContext);
  const number =
    stack === null || href === undefined || !href.startsWith(`${stack.repositoryUrl}/pull/`)
      ? null
      : Number(href.slice(stack.repositoryUrl.length + "/pull/".length));
  if (stack === null || number === null || !stack.layers.has(number))
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  return (
    <a
      href={href}
      data-stack-link={number}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        stack.open(number);
      }}
    >
      {children}
    </a>
  );
}
