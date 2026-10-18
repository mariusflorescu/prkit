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
}

export const readInboxRows = (browser: Browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll("main section[aria-label]")].map((section) => ({
      group: section.getAttribute("aria-label") ?? "",
      rows: [...section.querySelectorAll("a[data-pr-number]")].map((link) => {
        const mark = link.querySelector("[data-size]");
        const clock = link.querySelector("[data-clock]");
        const reading = mark?.lastElementChild;
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
