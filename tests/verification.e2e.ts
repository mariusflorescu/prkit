import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { repoRoot, runForUrl, serverBuildId } from "../scripts/verify-run.ts";
import { openInbox } from "./openInbox.ts";

test("doctor rejects a server from a different build", async ({ app, screen }) => {
  const run = runForUrl(app.baseUrl);
  await openInbox({ app, screen });
  await expect(screen.getByRole("heading", "Inbox")).toBeVisible();
  const doctor = () =>
    NodeChildProcess.spawnSync(
      process.execPath,
      ["scripts/verify-app.ts", "doctor", "--name", run.name],
      { cwd: repoRoot, encoding: "utf8" },
    );
  expect(doctor().status).toBe(0);
  const metadata = NodePath.join(repoRoot, "apps/server/dist/build.json");
  const original = NodeFS.readFileSync(metadata, "utf8");
  const buildId = serverBuildId();
  try {
    NodeFS.writeFileSync(metadata, JSON.stringify({ buildId: "different-build" }));
    const mismatch = doctor();
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain(`FAIL build ${buildId} (expected different-build)`);
  } finally {
    NodeFS.writeFileSync(metadata, original);
  }
  expect(doctor().status).toBe(0);
});
