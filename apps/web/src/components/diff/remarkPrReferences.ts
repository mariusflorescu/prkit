import type { Link, PhrasingContent, Root, RootContent, Text } from "mdast";

function linkReferences(text: Text, base: string): Array<Text | Link> {
  const result: Array<Text | Link> = [];
  let end = 0;
  for (const match of text.value.matchAll(/(?<![\w&/#])(?<![Ss]tack\s)#(\d{1,7})\b/g)) {
    if (match.index > end) result.push({ type: "text", value: text.value.slice(end, match.index) });
    result.push({
      type: "link",
      url: `${base}/pull/${match[1]}`,
      children: [{ type: "text", value: match[0] }],
    });
    end = match.index + match[0].length;
  }
  if (end < text.value.length) result.push({ type: "text", value: text.value.slice(end) });
  return result;
}

export function remarkPrReferences({ prUrl }: { prUrl?: string | undefined }) {
  return (tree: Root) => {
    if (!prUrl) return;
    const base = prUrl.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+(?:[/?#].*)?$/)?.[1];
    if (!base) return;
    const visit = (node: RootContent | PhrasingContent) => {
      if (node.type === "paragraph" || node.type === "strong" || node.type === "emphasis") {
        node.children = node.children.flatMap((child): Array<PhrasingContent> =>
          child.type === "text" ? linkReferences(child, base) : [child],
        );
      }
      if ("children" in node && node.type !== "link" && node.type !== "linkReference")
        node.children.forEach(visit);
    };
    tree.children.forEach(visit);
  };
}
