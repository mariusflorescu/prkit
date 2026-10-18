import * as Schema from "effect/Schema";

import type { Fixtures } from "./fixActions.ts";

const Row = Schema.NullOr(
  Schema.Struct({
    background: Schema.String,
    selected: Schema.Boolean,
    top: Schema.Number,
    bottom: Schema.Number,
    viewport: Schema.Number,
  }),
);
const decodeRow = Schema.decodeSync(Schema.fromJsonString(Row));

/** One code row of a card's diff, read inside its shadow root: its look and where it is. */
export const rowOf = async (
  { browser }: Fixtures,
  path: string,
  side: "old" | "new",
  line: number,
) =>
  decodeRow(
    await browser.evaluate(
      ({ path, type, line }) => {
        const root = document.querySelector(`[data-path="${path}"] diffs-container`)?.shadowRoot;
        const row = root?.querySelector(
          `[data-line][data-line-type="${type}"][data-line="${line}"]`,
        );
        if (!row) return "null";
        const box = row.getBoundingClientRect();
        return JSON.stringify({
          background: getComputedStyle(row).backgroundColor,
          selected: row.hasAttribute("data-selected-line"),
          top: box.top,
          bottom: box.bottom,
          viewport: window.innerHeight,
        });
      },
      { path, type: side === "old" ? "change-deletion" : "change-addition", line },
    ),
  );

/** The scope text in a card's separators, in order, and their heights. */
export const scopesOf = async ({ browser }: Fixtures, path: string) =>
  Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({ text: Schema.String, title: Schema.String, height: Schema.Number }),
      ),
    ),
  )(
    await browser.evaluate((path) => {
      const root = document.querySelector(`[data-path="${path}"] diffs-container`)?.shadowRoot;
      return JSON.stringify(
        [...(root?.querySelectorAll<HTMLElement>("[data-scope]") ?? [])].map((scope) => {
          const separator = scope.closest<HTMLElement>("[data-separator]");
          return {
            text: scope.textContent ?? "",
            title: separator?.title ?? "",
            height: separator?.getBoundingClientRect().height ?? 0,
          };
        }),
      );
    }, path),
  );
