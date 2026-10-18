import { hiddenScope, scopeLabel, type HunkScope, type ScopeLine } from "./scope";

const SEPARATOR = '[data-separator="line-info"]:not([data-separator-last])';

/**
 * Per separator of a column numbered by new lines, in order: the first new line shown
 * below it, and every new line shown between it and the separator above it.
 */
const separatorsOf = (column: Element) => {
  const found: Array<{ first: number | null; above: ReadonlySet<number> }> = [];
  let above = new Set<number>();
  let open: { first: number | null; above: ReadonlySet<number> } | null = null;
  for (const cell of column.children) {
    if (!(cell instanceof HTMLElement)) continue;
    if (cell.dataset.separator !== undefined) {
      open = cell.matches(SEPARATOR) ? { first: null, above } : null;
      if (open) found.push(open);
      above = new Set();
      continue;
    }
    if (cell.dataset.columnNumber === undefined || cell.dataset.lineType === "change-deletion")
      continue;
    const line = Number(cell.dataset.columnNumber);
    above.add(line);
    if (open && open.first === null) open.first = line;
  }
  return found;
};

const labelOf = (parts: ReadonlyArray<string>) => {
  const label = document.createElement("span");
  label.dataset.scope = "";
  parts.forEach((part, index) => {
    if (index > 0) {
      const between = document.createElement("span");
      between.dataset.scopeBetween = "";
      between.textContent = " › ";
      label.append(between);
    }
    label.append(part);
  });
  return label;
};

const paint = (separator: HTMLElement, chain: ReadonlyArray<ScopeLine>) => {
  const count = separator.querySelector<HTMLElement>("[data-unmodified-lines]");
  if (!count) return;
  const painted = count.querySelector(":scope > [data-scope]");
  if (chain.length === 0) {
    painted?.remove();
    count.removeAttribute("data-scoped");
    separator.removeAttribute("title");
    return;
  }
  const label = scopeLabel(chain);
  if (painted?.textContent !== label.text) {
    painted?.remove();
    count.prepend(labelOf(label.parts));
  }
  if (!count.hasAttribute("data-scoped")) count.setAttribute("data-scoped", "");
  if (separator.title !== label.title) separator.title = label.title;
};

/**
 * Writes the openers hidden above each hunk into its separator row, before the count of
 * unmodified lines. The lines come from the column numbered by new lines (the one column,
 * or split's right one) and the label shows in the gutter of the one column or split's left
 * one. Pierre redraws the label on every render, which drops what was written, so this runs
 * again after each render and writes nothing when the row already says the same.
 */
export function paintScopes(root: ShadowRoot, scopes: ReadonlyArray<HunkScope> | null) {
  const gutter = (column: string) => root.querySelector(`[data-${column}] [data-gutter]`);
  const numbered = gutter("unified") ?? gutter("additions");
  const shown = gutter("unified") ?? gutter("deletions");
  if (!numbered || !shown) return;
  const separators = separatorsOf(numbered);
  [...shown.children]
    .filter((cell) => cell.matches(SEPARATOR))
    .forEach((separator, index) => {
      const at = separators[index];
      if (!(separator instanceof HTMLElement)) return;
      paint(separator, scopes && at?.first != null ? hiddenScope(scopes, at.first, at.above) : []);
    });
}
