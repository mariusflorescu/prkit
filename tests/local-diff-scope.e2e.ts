import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import * as Schema from "effect/Schema";

import { LocalWaitResult } from "../apps/server/src/outside/schemas.ts";
import { scopesOf } from "./diffRows.ts";
import { setUpFakeClaude } from "./fakeClaude.ts";
import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { cliIn, dismissToasts, scratchRoot, switchOn } from "./localGuideSession.ts";
import { localRepoFixture } from "./localRepoFixture.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { SMARTER_DIFF, SMARTER_DIFF_FILES } from "./smarterDiffFixture.ts";

const decodeWait = Schema.decodeSync(Schema.fromJsonString(LocalWaitResult));
const ROUTER_SCOPE = `${SMARTER_DIFF.routerScope[0]} › … › ${SMARTER_DIFF.routerScope[2]} › ${SMARTER_DIFF.routerScope[3]}`;

test(
  "a guide of local changes names the scope above each hunk and shows moved code, from its own snapshot",
  { timeout: 300_000 },
  async ({ app, screen, browser }) => {
    const name = "local-diff-scope";
    const fake = await startFakeGitHub(name);
    const claude = setUpFakeClaude(name);
    const root = scratchRoot();
    const log: Array<string> = [];
    try {
      const fixture = localRepoFixture(root, "links", SMARTER_DIFF_FILES);
      const run = startFakeInstance(name, fake, ["--claude", claude.file]);
      const cli = cliIn(NodePath.join(run.home, "bin/prkit"), fake.home, log);
      claude.split(true);
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 800 });
      await switchOn({ app, screen, browser }, run.openUrl);
      expect(cli(fixture.repo, ["local", "guide", "--json"]).code).toBe(0);
      const waited = decodeWait(
        cli(fixture.repo, ["local", "wait", "--timeout", "120", "--json"]).stdout,
      );
      expect(waited.status).toMatchObject({ state: "ready", latestRevision: 1 });

      await screen.getByRole("link", "Open the local review of links · feature/limits").tap();
      await expect(screen.getByRole("heading", "links · feature/limits")).toBeVisible();
      await dismissToasts(browser);
      const router = screen.getByRole("region", SMARTER_DIFF.router);
      await router.scrollIntoView();
      await expect
        .poll(
          async () =>
            (await scopesOf({ app, screen, browser }, SMARTER_DIFF.router)).map((s) => s.text),
          {
            timeout: 60_000,
          },
        )
        .toEqual([ROUTER_SCOPE]);
      const [scoped] = await scopesOf({ app, screen, browser }, SMARTER_DIFF.router);
      for (const opener of SMARTER_DIFF.routerScope) expect(scoped?.title).toContain(opener);
      await screenshotLightAndDark(app, browser, "local-scope");

      const report = screen.getByRole("region", SMARTER_DIFF.report);
      await report.scrollIntoView();
      await expect(
        report.getByRole(
          "button",
          `Show src/report.js lines ${SMARTER_DIFF.rowLandedAt}-${SMARTER_DIFF.rowLandedAt + 5}`,
        ),
      ).toBeVisible({ timeout: 30_000 });
      await screenshotLightAndDark(app, browser, "local-moved");

      // The scope comes from prkit's snapshot: renaming the method in the working tree changes nothing.
      fixture.write(
        SMARTER_DIFF.router,
        SMARTER_DIFF_FILES.head[SMARTER_DIFF.router].replace(
          "async handle(req, res) {",
          "async dispatch(req, res) {",
        ),
      );
      await browser.reload();
      await screen.getByRole("region", SMARTER_DIFF.router).scrollIntoView();
      await expect
        .poll(
          async () =>
            (await scopesOf({ app, screen, browser }, SMARTER_DIFF.router)).map((s) => s.text),
          {
            timeout: 60_000,
          },
        )
        .toEqual([ROUTER_SCOPE]);
      const [after] = await scopesOf({ app, screen, browser }, SMARTER_DIFF.router);
      expect(after?.title).toContain("async handle(req, res) {");
      expect(after?.title).not.toContain("dispatch");
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      NodeFS.rmSync(root, { recursive: true, force: true });
      const evidence = NodePath.join(import.meta.dirname, "../.e2e/evidence", name);
      NodeFS.mkdirSync(evidence, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(evidence, "cli-transcript.txt"), log.join("\n\n"));
    }
  },
);
