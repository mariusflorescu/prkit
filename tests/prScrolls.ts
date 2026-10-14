import type { Browser } from "@e2e-dev/web";

/** Whether the page, and the PR view's own scroll area, are taller than the window. */
export const prScrolls = (browser: Browser) =>
  browser.evaluate(() => {
    const view = document.querySelector("[data-pr-scroll]");
    return {
      page: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      view: view === null ? null : view.scrollHeight > view.clientHeight,
    };
  });
