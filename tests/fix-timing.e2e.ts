import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { runForUrl } from "../scripts/verify-run.ts";
import {
  AGENT_WAIT,
  draftOn,
  fixerOf,
  fixesTab,
  openPull,
  openSendToAgent,
  pickModel,
  transcriptOf,
} from "./fixActions.ts";
import { closeFixFixture, createFixFixture } from "./fixFixture.ts";
import { AGENT_RUNS, AGENT_SKIP, NEEDS_FIXTURE, readRows } from "./fixturePr.ts";
import { LIMITS_PATH } from "./reviewFixture.ts";

interface Entry {
  readonly timestamp?: string;
  readonly message?: {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly id?: string;
      readonly tool_use_id?: string;
      readonly input?: { readonly command?: string };
    }>;
  };
}

/** A script run prkit lets through: the script alone, maybe piped into read-only commands. */
const SCRIPT_RUN = /^npm (run )?test\b(?!.*(;|&&|\|\|))/;

/** How long each `npm test` the agent ran took, from its call to its result, in milliseconds. */
const scriptRuns = (transcripts: ReadonlyArray<string>) => {
  const entries = transcripts
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.startsWith("{"))
    .map((line): Entry => JSON.parse(line));
  const calls = new Map<string, number>();
  const runs: Array<{ command: string; ms: number }> = [];
  const commands = new Map<string, string>();
  for (const entry of entries)
    for (const block of entry.message?.content ?? []) {
      const at = Date.parse(entry.timestamp ?? "");
      const command = block.input?.command ?? "";
      if (block.type === "tool_use" && block.id !== undefined && SCRIPT_RUN.test(command)) {
        calls.set(block.id, at);
        commands.set(block.id, command);
      }
      const started = block.tool_use_id === undefined ? undefined : calls.get(block.tool_use_id);
      if (block.type === "tool_result" && block.tool_use_id !== undefined && started !== undefined)
        runs.push({ command: commands.get(block.tool_use_id) ?? "", ms: at - started });
    }
  return runs;
};

describe("fix timing", { tags: ["timing"], skip: NEEDS_FIXTURE }, () => {
  test(
    "Claude Sonnet fixes one draft on the fix fixture and runs its tests, timed from the turn's start",
    { timeout: 900_000 },
    async (fixtures) => {
      test.skip(!AGENT_RUNS, AGENT_SKIP);
      const { app, screen } = fixtures;
      const run = runForUrl(app.baseUrl);
      const fixture = createFixFixture(`${Date.now()}`);
      try {
        await openPull(fixtures, fixture, "files");
        await expect(screen.getByRole("region", LIMITS_PATH)).toBeVisible({ timeout: 60_000 });
        await draftOn(
          fixtures,
          3,
          "Rename `MAX_CODE_LENGTH` to `CODE_LIMIT` everywhere it is used.",
        );
        const dialog = await openSendToAgent(fixtures, 1);
        await pickModel(fixtures, dialog, "sonnet", /Claude Sonnet/);
        await dialog.getByRole("button", "Send 1 comment to agent").tap();
        await fixesTab(fixtures).tap();
        await expect(screen.getByRole("article", "Fix 1 comment: Ready to review")).toBeVisible({
          timeout: AGENT_WAIT,
        });
        // A turn's finished_at waits for Push or Discard, so Ready is timed here.
        const readyAt = new Date().toISOString();
        const [turn] = readRows(
          run.home,
          "SELECT started_at, agent_started, json_extract(scripts, '$._tag') AS scripts FROM fixer_turns ORDER BY created_at DESC LIMIT 1",
        );
        const fixer = fixerOf(run.home, fixture.number);
        const runs = scriptRuns(
          transcriptOf(
            run.home,
            "claude",
            NodePath.join(run.home, "fixes", String(fixer?.id)),
            String(fixer?.session),
          ),
        );
        expect(turn?.scripts).toBe("allowed");
        expect(runs.length).toBeGreaterThan(0);
        const out = NodePath.resolve(import.meta.dirname, "../.e2e/evidence/fix-timing");
        NodeFs.mkdirSync(out, { recursive: true });
        NodeFs.writeFileSync(
          NodePath.join(out, `${new Date().toISOString().replaceAll(":", "-")}.json`),
          JSON.stringify(
            {
              turnMs: Date.parse(readyAt) - Date.parse(String(turn?.started_at)),
              turn: { ...turn, readyAt },
              runs,
              log: run.log,
            },
            null,
            2,
          ),
        );
      } finally {
        closeFixFixture(fixture);
      }
    },
  );
});
