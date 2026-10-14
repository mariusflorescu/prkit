/**
 * The local-first figure's card, built at build time: your Mac as a dashed boundary, holding prkit's window, its
 * memory with one token per account, your agent's terminal and prkit's data folder, with one line out to GitHub and
 * the agent's own line to its login. Where a prkit server would be there is nothing.
 */
import * as k from "../kit/iso-kit.mjs";
import { DIGITAL_CSS } from "../kit/prkit-digital.mjs";
import { legend } from "../kit/prkit-frame.ts";
import { H, W, drawing } from "./geometry.mjs";
import { ACCOUNTS, STEPS } from "./model.mjs";

const LABELS = {
  github: ["GitHub", "show a request carrying your token to GitHub"],
  agent: ["Your agent", "show a job going to your agent, without your GitHub token"],
  disk: ["Disk", "search prkit's data folder for a GitHub token"],
};

export function figure() {
  const svg = k.figureSvg({
    width: W,
    height: H,
    label: `Local first, as a diagram of the software on your Mac. A dashed boundary for your Mac holds prkit's window with its inbox, prkit's memory holding one GitHub token for each of ${ACCOUNTS.length} accounts, your agent's terminal, whose environment has no GitHub token, and prkit's data folder, where a search for a GitHub token finds nothing. One line leaves for GitHub's API. Your agent, its cursor in rose, has its own line to the Claude or Codex login it runs on. A dashed, crossed-out empty frame stands where a prkit server would be, joined to nothing.`,
    body: [
      `<style>${DIGITAL_CSS}.lo-halo{fill:var(--anatomy-paper);fill-opacity:.85;stroke:var(--anatomy-faint);stroke-width:.5;vector-effect:non-scaling-stroke}</style>`,
      drawing(),
    ],
  });
  return {
    svg,
    title: "Two connections",
    hint: "Pick one to follow it",
    caption:
      "prkit talks to GitHub and to your agent, and nothing else. Each account's GitHub token stays in prkit's memory, never on disk, and goes only to GitHub. Your agent runs on your own login, on its own copy, without your GitHub token.",
    legend: legend([
      { mark: "lit", label: "Rose: your agent, and what it works on" },
      { mark: "dim", label: "Dashed: your Mac, and your agent's own line to its login" },
    ]),
    controls: STEPS.map(
      ({ name }) =>
        `<button type="button" data-step="${name}" aria-pressed="false" aria-label="${LABELS[name][0]}: ${LABELS[name][1]}">${LABELS[name][0]}</button>`,
    ).join(""),
  };
}
