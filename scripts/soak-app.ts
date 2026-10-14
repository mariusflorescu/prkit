import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { chromium, type Page } from "playwright";

import { isValidName, readRun, repoRoot, serverBuildId } from "./verify-run.ts";

const [
  name = "hang",
  duration = "1800",
  label = "soak",
  refreshCadence = "180",
  pullCadence = "90",
] = process.argv.slice(2);
const seconds = Number(duration);
const refreshSeconds = Number(refreshCadence);
const pullSeconds = Number(pullCadence);
if (
  !isValidName(name) ||
  !isValidName(label) ||
  !Number.isInteger(seconds) ||
  seconds < 1 ||
  !Number.isInteger(refreshSeconds) ||
  refreshSeconds < 1 ||
  !Number.isInteger(pullSeconds) ||
  pullSeconds < 1
)
  throw new Error(
    "Usage: node scripts/soak-app.ts <instance> <seconds> <label> [inbox-refresh-seconds] [pull-cycle-seconds]",
  );
const run = Option.getOrThrow(readRun(name));
const dir = NodePath.join(repoRoot, ".e2e/evidence", name, label);
NodeFS.mkdirSync(dir, { recursive: true });
const healthFile = NodePath.join(dir, "health.csv");
const rssFile = NodePath.join(dir, "rss.csv");
const actionsFile = NodePath.join(dir, "actions.jsonl");
NodeFS.writeFileSync(healthFile, "timestamp,elapsed_s,status,latency_ms,valid_build,error\n");
NodeFS.writeFileSync(rssFile, "timestamp,elapsed_s,rss_kib,cpu_percent\n");
NodeFS.writeFileSync(actionsFile, "");
const encodeAction = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const inboxStart = new URL(run.openUrl);
inboxStart.pathname = "/settings";
const log = (value: Record<string, Schema.Json>) =>
  NodeFS.appendFileSync(
    actionsFile,
    `${encodeAction({ timestamp: new Date().toISOString(), ...value })}\n`,
  );
const Health = Schema.Struct({ ok: Schema.Boolean, home: Schema.String, buildId: Schema.String });
const decodeHealth = Schema.decodeUnknownSync(Health);
const expectedBuild = serverBuildId();
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const pages = await Promise.all([
  context.newPage(),
  context.newPage(),
  context.newPage(),
  context.newPage(),
]);
const started = performance.now();
const deadline = started + seconds * 1000;
const stop = new AbortController();
const active = () => !stop.signal.aborted && performance.now() < deadline;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rest = (ms: number) =>
  new Promise<void>((resolve) => {
    if (stop.signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.signal.addEventListener("abort", done, { once: true });
  });
const stats = {
  inboxRefreshes: 0,
  pullReads: 0,
  failures: 0,
  alerts: 0,
  healthFailures: 0,
  slowHealth: 0,
  rateLimited: false,
};
let instanceStopped = false;
const stopInstance = () =>
  execute(process.execPath, [
    NodePath.join(repoRoot, "scripts/verify-app.ts"),
    "stop",
    "--name",
    name,
    "--keep-home",
  ]);
const checkBudget = async (alerts: ReadonlyArray<string>) => {
  if (
    stats.rateLimited ||
    !alerts.some((alert) => /rate.?limit|already exceeded|secondary limit/i.test(alert))
  )
    return;
  stats.rateLimited = true;
  log({ kind: "rate-limit-stop", message: "Stopped GitHub load at its first rate-limit alert." });
  stop.abort();
  await stopInstance();
  instanceStopped = true;
};
for (const page of pages) {
  page.setDefaultTimeout(45_000);
  page.on("pageerror", (error) => {
    stats.failures++;
    log({ kind: "pageerror", message: error.message });
  });
}
/**
 * The PRs the reader cycles through: the Inbox's first PR from each account, read through that
 * account, and a large public PR read through the first one.
 */
const discoverRefs = async (page: Page) => {
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await page.locator("a[data-repository]").first().waitFor();
  const rows = await page.locator("a[data-repository]").evaluateAll((links) =>
    links.map((link) => ({
      ref: `${link.getAttribute("data-repository")}/${link.getAttribute("data-pr-number")}`,
      account: link.getAttribute("data-account") ?? "",
    })),
  );
  const firstPerAccount = rows.filter(
    (row, index) => rows.findIndex((other) => other.account === row.account) === index,
  );
  return [
    ...firstPerAccount,
    { ref: "pingdotgg/t3code/16782", account: firstPerAccount[0]?.account ?? "" },
  ];
};

const monitor = async () => {
  let index = 0;
  while (active()) {
    const elapsed = (performance.now() - started) / 1000;
    const timestamp = new Date().toISOString();
    if (index % 10 === 0) {
      const { stdout } = await execute("ps", ["-o", "rss=,%cpu=", "-p", String(run.serverPid)]);
      const [rss, cpu] = stdout.trim().split(/\s+/).map(Number);
      NodeFS.appendFileSync(rssFile, `${timestamp},${elapsed.toFixed(3)},${rss},${cpu}\n`);
    }
    const before = performance.now();
    let status = 0;
    let valid = false;
    let error = "";
    try {
      const response = await fetch(`${run.url}/health`, { signal: AbortSignal.timeout(3000) });
      status = response.status;
      const body = decodeHealth(await response.json());
      valid = body.ok && body.home === run.home && body.buildId === expectedBuild;
    } catch (failure) {
      error = String(failure).replaceAll(",", ";");
    }
    const latency = performance.now() - before;
    if (status !== 200 || !valid) stats.healthFailures++;
    if (latency >= 200) stats.slowHealth++;
    NodeFS.appendFileSync(
      healthFile,
      `${timestamp},${elapsed.toFixed(3)},${status},${latency.toFixed(3)},${valid},${error}\n`,
    );
    index++;
    await sleep(Math.max(0, started + index * 1000 - performance.now()));
  }
};

const inbox = async (page: Page, worker: number) => {
  await page.goto(inboxStart.href);
  while (active()) {
    try {
      await page.getByRole("link", { name: "Inbox", exact: true }).click();
      await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
      await page.locator("a[data-repository]").first().waitFor();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page
        .getByRole("button", { name: "Refreshing...", exact: true })
        .waitFor({ state: "visible" });
      await page
        .getByRole("button", { name: "Refreshing...", exact: true })
        .waitFor({ state: "hidden" });
      const rows = await page.locator("a[data-repository]").count();
      const alerts = await page.getByRole("alert").allTextContents();
      stats.inboxRefreshes++;
      stats.alerts += alerts.length;
      if (rows === 0) stats.failures++;
      log({ kind: "inbox", worker, rows, alerts });
      await checkBudget(alerts);
      await rest(refreshSeconds * 1000);
    } catch (error) {
      stats.failures++;
      log({ kind: "failure", worker, message: String(error) });
      if (active()) await page.goto(inboxStart.href);
    }
  }
};

const pulls = async (page: Page) => {
  await page.goto(run.openUrl);
  const refs = await discoverRefs(page);
  let cycle = 0;
  while (active()) {
    for (const { ref, account } of refs) {
      for (const tab of ["conversation", "files"]) {
        if (!active()) return;
        try {
          await page.goto(
            `${run.url}/pr/github.com/${ref}?account=${encodeURIComponent(account)}&tab=${tab}`,
          );
          await page.locator("[data-reading-account]").waitFor();
          if (tab === "conversation") {
            await page
              .locator('section[aria-label="Activity"] [data-timeline-kind]')
              .first()
              .waitFor();
            await page.getByRole("button", { name: "Refresh", exact: true }).click();
            await page
              .locator("button:not([disabled])")
              .filter({ hasText: /^Refresh$/ })
              .waitFor();
          }
          if (tab === "files") {
            await page.locator("[data-file-diff-card]").first().waitFor();
            const expand = page.locator("[data-unmodified-lines]").first();
            if (await expand.count()) await expand.click();
          }
          const alerts = await page.getByRole("alert").allTextContents();
          stats.pullReads++;
          stats.alerts += alerts.length;
          log({
            kind: "pull",
            cycle,
            ref,
            account,
            tab,
            files: await page.locator("[data-file-diff-card]").count(),
            alerts,
          });
          await checkBudget(alerts);
        } catch (error) {
          stats.failures++;
          log({ kind: "failure", ref, tab, message: String(error) });
        }
      }
    }
    cycle++;
    if (cycle % 10 === 0) await page.screenshot({ path: NodePath.join(dir, `cycle-${cycle}.png`) });
    await rest(pullSeconds * 1000);
  }
};

try {
  const tasks = pages.map((page, index) => (index === 2 ? pulls(page) : inbox(page, index)));
  await Promise.all([monitor(), ...tasks]);
} finally {
  await browser.close();
  if (stats.rateLimited && !instanceStopped) await stopInstance();
}
NodeFS.writeFileSync(
  NodePath.join(dir, "summary.json"),
  encodeAction({ elapsedSeconds: (performance.now() - started) / 1000, ...stats }),
);
process.stdout.write(`${encodeAction(stats)}\n`);
if (stats.healthFailures > 0 || stats.slowHealth > 0 || stats.failures > 0 || stats.rateLimited)
  process.exitCode = 1;
