/**
 * The inbox list's card, built at build time: the prkit window on the Inbox, its toolbar with the account select,
 * and the three groups, each row carrying the emblem of the account that found it. One row's first guide is being
 * written, so it carries the agent's rose cursor.
 */
import * as k from "../kit/iso-kit.mjs";
import { DIGITAL_CSS } from "../kit/prkit-digital.mjs";
import { legend } from "../kit/prkit-frame.ts";
import { drawing } from "./geometry.mjs";
import { ACCOUNTS, GROUPS, MEMBERS, PULLS } from "./model.mjs";
import { HEIGHT, WIDTH } from "./view.mjs";

const shapes = ACCOUNTS.map((account) => `${account.name} a ${account.emblem}`).join(", ");

export function figure() {
  const svg = k.figureSvg({
    width: WIDTH,
    height: HEIGHT,
    label: `The prkit window on its Inbox. Beside the search field, an account select set to All accounts, and a repository select. ${PULLS.length} pull requests are listed in three groups, each with its count: ${GROUPS.map((group, i) => `${group.title} ${MEMBERS[i].length}`).join(", ")}. Every row shows the pull request's state, its checks when it has any, title, author, repository and size, and the emblem of the account that found it: ${shapes}. One row in Needs your review says its guide is being written, with your agent's rose cursor beside it. Picking an account opens the select, and every group narrows to that account's rows.`,
    body: [`<style>${DIGITAL_CSS}</style>`, drawing()],
  });
  return {
    svg,
    title: "One inbox",
    hint: "Pick an account",
    caption:
      "Pull requests from every gh login on your Mac land in one inbox, grouped by why they need you: Needs your review, Yours, Involved. Each row stays tied to the account that found it. Pick one account and every group narrows to it.",
    legend: legend([{ mark: "lit", label: "Rose: your agent writing a guide" }]),
    controls: [
      `<button type="button" data-pick="all" aria-pressed="true" aria-label="All accounts: show every account's pull requests">All accounts</button>`,
      ...ACCOUNTS.map(
        (account, index) =>
          `<button type="button" data-pick="${index}" aria-pressed="false" aria-label="${account.name}: show only this account's pull requests">${account.name}</button>`,
      ),
    ].join(""),
  };
}
