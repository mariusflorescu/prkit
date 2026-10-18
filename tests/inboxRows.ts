import type { Browser } from "@e2e-dev/web";

export interface InboxRowFacts {
  number: number;
  chip: string;
  reading: string;
  readingVisible: boolean;
  label: string;
  title: string;
  at: string;
  left: number;
  stacked: boolean;
  height: number;
  /** The row's guide mark, `ready` or `writing`, empty when it has none. */
  guide: string;
  /** The row's risk chip level, empty when it has none. */
  risk: string;
  riskText: string;
  /** Whether the chip sits inside the row's box. */
  riskInside: boolean;
  titleWidth: number;
}

export const readInboxRows = (browser: Browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll("main section[aria-label]")].map((section) => ({
      group: section.getAttribute("aria-label") ?? "",
      rows: [...section.querySelectorAll("a[data-pr-number]")].map((link) => {
        const mark = link.querySelector("[data-size]");
        const clock = link.querySelector("[data-clock]");
        const reading = mark?.lastElementChild;
        const risk = link.querySelector("[data-risk-tag]");
        const box = link.getBoundingClientRect();
        const riskBox = risk?.getBoundingClientRect();
        return {
          number: Number(link.getAttribute("data-pr-number")),
          chip: mark?.getAttribute("data-size") ?? "",
          reading: reading?.textContent ?? "",
          readingVisible:
            reading instanceof Element && getComputedStyle(reading).display !== "none",
          label: clock?.textContent ?? "",
          title: link.getAttribute("title") ?? "",
          at: clock?.getAttribute("datetime") ?? "",
          left: clock?.parentElement?.getBoundingClientRect().left ?? -1,
          stacked: /Stack \d+\/\d+/.test(link.textContent ?? ""),
          height: box.height,
          guide: link.querySelector("[data-guide-mark]")?.getAttribute("data-guide-mark") ?? "",
          risk: risk?.getAttribute("data-risk") ?? "",
          riskText: risk?.textContent ?? "",
          riskInside:
            riskBox !== undefined && riskBox.left >= box.left && riskBox.right <= box.right,
          titleWidth: link.querySelector(".truncate")?.getBoundingClientRect().width ?? 0,
        };
      }),
    })),
  );

export const inboxOrder = async (browser: Browser) =>
  Object.fromEntries(
    (await readInboxRows(browser)).map((group) => [
      group.group,
      group.rows.map((row) => row.number),
    ]),
  );
