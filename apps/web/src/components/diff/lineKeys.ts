import type { LinePoint } from "@prkit/contracts";

import type { DiffInteraction, LineRange } from "./types";

/** How a line number is announced, by what picking lines does on this diff. */
const GUTTER_VERB: Record<DiffInteraction["kind"], string> = {
  comment: "Comment on",
  ask: "Ask about",
};

const NUMBER = "[data-gutter] > [data-column-number]";

/** The line a gutter cell numbers: its column's side, or in one column its row's. */
const pointOf = (cell: Element): LinePoint | null => {
  if (!(cell instanceof HTMLElement) || !cell.matches(NUMBER)) return null;
  const code = cell.closest("code");
  const line = Number(cell.dataset.columnNumber);
  if (code === null || !Number.isInteger(line)) return null;
  const old =
    code.hasAttribute("data-deletions") ||
    (!code.hasAttribute("data-additions") && cell.dataset.lineType === "change-deletion");
  return { side: old ? "old" : "new", line };
};

const sameLine = (a: LinePoint | null, b: LinePoint | null) =>
  a !== null && b !== null && a.side === b.side && a.line === b.line;

const numbersOf = (gutter: Element | null) =>
  gutter === null ? [] : [...gutter.querySelectorAll<HTMLElement>(":scope > [data-column-number]")];

/** The one cell of its gutter that Tab reaches. */
const makeStop = (cell: HTMLElement, point: LinePoint, verb: string) => {
  for (const other of numbersOf(cell.parentElement))
    if (other !== cell && other.tabIndex === 0) other.tabIndex = -1;
  cell.tabIndex = 0;
  cell.role = "button";
  cell.ariaLabel = `${verb} ${point.side === "old" ? "old " : ""}line ${point.line}`;
};

/** The gutter cell numbering `point` inside a rendered diff, if the diff shows that line. */
export const cellAt = (root: ParentNode, point: LinePoint) =>
  [...root.querySelectorAll<HTMLElement>(NUMBER)].find((cell) => sameLine(pointOf(cell), point));

/**
 * Where each drawn diff of `path` under `root` shows `range`, from the higher of its two ends'
 * line numbers to the lower (in split view an old start can sit below a new end), with the card
 * that holds that diff.
 */
export const drawnRanges = (root: ParentNode, path: string, range: LineRange) =>
  [
    ...root.querySelectorAll<HTMLElement>(`[data-file-diff-card][data-path="${CSS.escape(path)}"]`),
  ].flatMap((card) => {
    const shadow = card.querySelector("diffs-container")?.shadowRoot;
    const start = shadow && cellAt(shadow, range.start)?.getBoundingClientRect();
    const end = shadow && cellAt(shadow, range.end)?.getBoundingClientRect();
    return start && end
      ? [
          {
            card,
            top: Math.min(start.top, end.top),
            bottom: Math.max(start.bottom, end.bottom),
          },
        ]
      : [];
  });

/**
 * Line numbers as a keyboard path to picking lines, which Pierre only offers to a pointer.
 * Each gutter is one tab stop. Arrows, Home and End move along it, Shift extends a
 * range, Enter or Space picks the line or range, and Escape or leaving the line
 * numbers drops the range. Assistive tech's click (VoiceOver's VO+Space, Voice
 * Control's "click") picks like Enter.
 */
export const makeLineKeys = (
  /** The range Shift is extending, to highlight; null once dropped or used. */
  onRange: (range: LineRange | null) => void,
) => {
  let host: HTMLElement | null = null;
  let onSelect: (range: LineRange) => void = () => {};
  let verb = GUTTER_VERB.comment;
  let current: LinePoint | null = null;
  let anchor: { cell: HTMLElement; point: LinePoint } | null = null;
  let range: LineRange | null = null;
  let returnTo: LinePoint | null = null;
  /** The line number that has focus; Pierre's redraw can take it out of the page. */
  let focused: HTMLElement | null = null;
  const setRange = (next: LineRange | null) => {
    range = next;
    if (next === null) anchor = null;
    onRange(next);
  };
  const selectFrom = (point: LinePoint) => {
    returnTo = point;
    onSelect(range ?? { start: point, end: point });
    setRange(null);
  };
  const onKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || !(event.target instanceof HTMLElement)) return;
    const cell = event.target;
    const point = pointOf(cell);
    if (point === null) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) selectFrom(point);
      return;
    }
    if (event.key === "Escape" && range !== null) {
      event.preventDefault();
      event.stopPropagation();
      setRange(null);
      return;
    }
    const numbers = numbersOf(cell.parentElement);
    const index = numbers.indexOf(cell);
    const next =
      event.key === "ArrowDown"
        ? numbers[index + 1]
        : event.key === "ArrowUp"
          ? numbers[index - 1]
          : event.key === "Home"
            ? numbers[0]
            : event.key === "End"
              ? numbers.at(-1)
              : undefined;
    const nextPoint = next === undefined ? null : pointOf(next);
    if (next === undefined || nextPoint === null) return;
    event.preventDefault();
    if (event.shiftKey) {
      anchor ??= { cell, point };
      setRange(
        numbers.indexOf(anchor.cell) <= numbers.indexOf(next)
          ? { start: anchor.point, end: nextPoint }
          : { start: nextPoint, end: anchor.point },
      );
    } else if (range !== null) setRange(null);
    current = nextPoint;
    makeStop(next, nextPoint, verb);
    next.focus();
  };
  const onFocusIn = (event: Event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const point = pointOf(event.target);
    if (point === null) return;
    current = point;
    focused = event.target;
    makeStop(event.target, point, verb);
  };
  // A pointer's click on a line number is Pierre's line selection; a click with no
  // pointer behind it (detail 0) is assistive tech pressing the button.
  const onClick = (event: Event) => {
    if (!(event instanceof MouseEvent) || event.detail !== 0) return;
    const cell = event.target instanceof Element ? event.target.closest(NUMBER) : null;
    const point = cell === null ? null : pointOf(cell);
    if (point !== null) selectFrom(point);
  };
  const onFocusOut = (event: Event) => {
    const cell = event.target;
    const root = event.currentTarget;
    queueMicrotask(() => {
      // Removed by a redraw, the cell keeps its claim for attach to settle.
      if (!(cell instanceof Node) || !cell.isConnected) return;
      if (cell === focused) focused = null;
      const now = root instanceof ShadowRoot ? root.activeElement : null;
      if (range !== null && (now === null || pointOf(now) === null)) setRange(null);
    });
  };
  return {
    /** After each Pierre render: listens on its shadow root and marks each gutter's tab stop. */
    attach: (
      rendered: HTMLElement,
      select: (range: LineRange) => void,
      kind: DiffInteraction["kind"],
    ) => {
      const root = rendered.shadowRoot;
      if (root === null) return;
      host = rendered;
      onSelect = select;
      verb = GUTTER_VERB[kind];
      root.addEventListener("keydown", onKeyDown);
      root.addEventListener("focusin", onFocusIn);
      root.addEventListener("focusout", onFocusOut);
      root.addEventListener("click", onClick);
      for (const gutter of root.querySelectorAll("[data-gutter]")) {
        const numbers = numbersOf(gutter);
        const stop = numbers.find((cell) => sameLine(pointOf(cell), current)) ?? numbers[0];
        const point = stop === undefined ? null : pointOf(stop);
        if (stop !== undefined && point !== null) makeStop(stop, point, verb);
      }
      if (focused !== null && !focused.isConnected) {
        const lost = document.activeElement === document.body;
        focused = null;
        if (lost && current !== null) cellAt(root, current)?.focus({ preventScroll: true });
      }
    },
    detach: () => {
      host?.shadowRoot?.removeEventListener("keydown", onKeyDown);
      host?.shadowRoot?.removeEventListener("focusin", onFocusIn);
      host?.shadowRoot?.removeEventListener("focusout", onFocusOut);
      host?.shadowRoot?.removeEventListener("click", onClick);
      host = null;
    },
    /** The composer closed: focus goes back to the line it opened from, unless it moved on. */
    restore: () => {
      const root = host?.shadowRoot;
      const back = returnTo;
      // Nothing opened from a line here, so a line focused since (a link's) keeps its claim.
      if (back === null) return;
      returnTo = null;
      focused = null;
      if (root && document.activeElement === document.body)
        cellAt(root, back)?.focus({ preventScroll: true });
    },
  };
};
