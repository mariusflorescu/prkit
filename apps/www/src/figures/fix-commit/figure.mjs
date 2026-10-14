/**
 * The fix figure's card, built at build time: two review threads on the pull request's diff go to your agent as
 * one batch, the agent edits its own checkout of the file, prkit makes one commit, and the branch waits one commit
 * ahead of GitHub's until you press Push. Only prkit holds the token.
 */
import * as k from "../kit/iso-kit.mjs";
import { DIGITAL_CSS } from "../kit/prkit-digital.mjs";
import { legend } from "../kit/prkit-frame.ts";
import { STYLE, drawing } from "./geometry.mjs";
import { THREADS } from "./model.mjs";
import { HEIGHT, WIDTH } from "./view.mjs";

export function figure() {
  const svg = k.figureSvg({
    width: WIDTH,
    height: HEIGHT,
    label: `Fixing review comments, in the order it happens. On the pull request's diff, ${THREADS.length} review threads are ticked and sent as one batch to your agent's terminal session, where a rose cursor works. The agent writes its edits into its own checkout of the same file, a removed line struck through and new lines raised. In the Fixes tab, the turn is ready to review: each comment marked fixed, the line saying prkit made the commit, and Push waiting for you. Beside it, the branch graph shows prkit's commit sitting one ahead of the branch on GitHub. Below, prkit's environment holds the GitHub token in memory, and the agent's environment lists plain variables and no token. Only prkit's token line reaches Push.`,
    body: [`<style>${DIGITAL_CSS}${STYLE}</style>`, drawing()],
  });
  return {
    svg,
    title: "Fixes, on a copy",
    hint: "Push sends the commit",
    caption:
      "Send review comments to your agent as one batch. It edits its own checkout of the branch, and prkit makes one commit for the batch. The token stays with prkit, and by default nothing reaches GitHub until you push.",
    legend: legend([
      { mark: "lit", label: "Rose: your agent at work" },
      { mark: "raised", label: "Raised rows: the lines it adds" },
    ]),
    controls: `<button type="button" data-push aria-disabled="true" aria-label="Push: send the commit to GitHub">Push</button>`,
  };
}
