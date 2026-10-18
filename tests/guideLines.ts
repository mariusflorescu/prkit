import type { Browser } from "@e2e-dev/web";
import type { Screen } from "e2e";

/** Taps a file:line chip, then reads where its line landed 100 ms and 1.5 s later. */
export const lineOpener =
  (screen: Screen, browser: Browser) => async (path: string, line: number) => {
    await screen.getByRole("button", `Open ${path} line ${line}`).tap();
    return browser.evaluate(
      async (target: { path: string; line: number }) => {
        const read = () => {
          const card = document.querySelector<HTMLElement>(
            `[data-file-diff-card][data-path="${target.path}"]`,
          );
          const root = card?.querySelector("diffs-container")?.shadowRoot;
          const cell = [
            ...(root?.querySelectorAll<HTMLElement>(
              `[data-gutter] > [data-column-number="${target.line}"]`,
            ) ?? []),
          ].find((candidate) => {
            const code = candidate.closest("code");
            return (
              code !== null &&
              !code.hasAttribute("data-deletions") &&
              (code.hasAttribute("data-additions") ||
                candidate.dataset.lineType !== "change-deletion")
            );
          });
          return {
            open: card?.dataset.open === "true",
            focused: card !== null && document.activeElement === card,
            selected: [
              ...(root?.querySelectorAll<HTMLElement>(
                "[data-gutter] > [data-selected-line][data-column-number]",
              ) ?? []),
            ].map((selected) => Number(selected.dataset.columnNumber)),
            top: cell ? Math.round(cell.getBoundingClientRect().top) : null,
            height: window.innerHeight,
            pageScroll: document.scrollingElement?.scrollTop ?? 0,
          };
        };
        // Each read waits for the next painted frame: alignment runs before paint.
        const at = (ms: number) =>
          new Promise((resolve) => setTimeout(resolve, ms)).then(
            () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
          );
        await at(100);
        const early = read();
        await at(1400);
        return { early, late: read() };
      },
      { path, line },
    );
  };
