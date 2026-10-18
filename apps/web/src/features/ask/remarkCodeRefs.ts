import type { InlineCode, Link, PhrasingContent, Root, RootContent, Text } from "mdast";

/** Where a `path:line` or `path:start-end` link points, carried in its URL. */
export const CODE_REF = "#prkit-line:";

const REF = /^([^\s:`]+):(\d+)(?:-\d+)?$/;
const REFS = /(?<![\w./@+-])([\w./@+-]+):(\d+)(?:-\d+)?(?![\w-])/g;

const link = (path: string, line: string, children: Array<Text | InlineCode>): Link => ({
  type: "link",
  url: `${CODE_REF}${line}:${encodeURIComponent(path)}`,
  children,
});

/** The line a code reference link opens, or null for any other URL. */
export const parseCodeRef = (href: string | undefined) => {
  if (href === undefined || !href.startsWith(CODE_REF)) return null;
  const [line = "", ...path] = href.slice(CODE_REF.length).split(":");
  const number = Number(line);
  return Number.isInteger(number) && number > 0
    ? { path: decodeURIComponent(path.join(":")), line: number }
    : null;
};

/**
 * Links `path:line` and `path:start-end` in text and inline code when `path` is one of
 * `files`, the files of the diff the answer was written about. Anything else stays as written.
 */
export function remarkCodeRefs({ files }: { files: ReadonlySet<string> }) {
  const inText = (text: Text): Array<PhrasingContent> => {
    const result: Array<PhrasingContent> = [];
    let end = 0;
    for (const match of text.value.matchAll(REFS)) {
      const [whole, path = "", line = ""] = match;
      if (!files.has(path)) continue;
      if (match.index > end)
        result.push({ type: "text", value: text.value.slice(end, match.index) });
      result.push(link(path, line, [{ type: "text", value: whole }]));
      end = match.index + whole.length;
    }
    if (end === 0) return [text];
    if (end < text.value.length) result.push({ type: "text", value: text.value.slice(end) });
    return result;
  };
  const linkRefs = (child: PhrasingContent): Array<PhrasingContent> => {
    if (child.type === "text") return inText(child);
    if (child.type !== "inlineCode") return [child];
    const [, path = "", line = ""] = REF.exec(child.value.trim()) ?? [];
    return files.has(path) ? [link(path, line, [child])] : [child];
  };
  const visit = (node: RootContent | PhrasingContent) => {
    switch (node.type) {
      case "link":
      case "linkReference":
        return;
      case "paragraph":
      case "heading":
      case "emphasis":
      case "strong":
      case "delete":
      case "tableCell":
        node.children = node.children.flatMap(linkRefs);
        break;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  return (tree: Root) => tree.children.forEach(visit);
}
