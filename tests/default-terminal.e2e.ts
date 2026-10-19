import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen, type TestFixtures } from "e2e";
import * as Schema from "effect/Schema";

import { startFakeGitHub, startFakeInstance, stopFakeInstance } from "./fakeGitHub.ts";
import { emulateOsColorScheme, screenshotLightAndDark } from "./osColorScheme.ts";
import { pressShortcut } from "./shortcut.ts";

const decodeToasts = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Every toast's title and description as it appears, since a toast leaves after five seconds. */
const recordToasts = (browser: Browser) =>
  browser.evaluate(() => {
    const seen = new Map<Element, string>();
    const textOf = (id: string | null) =>
      (id === null ? null : document.getElementById(id))?.textContent ?? "";
    new MutationObserver(() => {
      for (const toast of document.querySelectorAll('[aria-label="Notifications"] [role="dialog"]'))
        seen.set(
          toast,
          `${textOf(toast.getAttribute("aria-labelledby"))} | ${textOf(toast.getAttribute("aria-describedby"))}`,
        );
      sessionStorage.setItem("e2e:toasts", JSON.stringify([...seen.values()]));
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    return null;
  });
const toasts = async (browser: Browser) =>
  decodeToasts(await browser.evaluate(() => sessionStorage.getItem("e2e:toasts") ?? "[]"));
/** Waits for every toast to leave, so a frame shows only what the next tap brings. */
const toastsGone = (browser: Browser) =>
  expect(browser.locator('[aria-label="Notifications"] [role="dialog"]')).toHaveCount(0, {
    timeout: 30_000,
  });

/**
 * Stand-ins for the macOS tools prkit opens a terminal with. `osascript` answers the default
 * terminal from `default` ("unreadable" fails it), and `open` records its call, refuses any app
 * listed in `refuse`, and otherwise runs the file the way a terminal does, with an `npx` that
 * records how the installer was started.
 */
const standIns = (state: string) => {
  const bin = NodePath.join(state, "bin");
  const npxBin = NodePath.join(state, "npx-bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.mkdirSync(npxBin, { recursive: true });
  const write = (file: string, text: string) => NodeFS.writeFileSync(file, text, { mode: 0o700 });
  write(
    NodePath.join(bin, "osascript"),
    `#!/bin/sh
printf '%s\\n' "$@" > '${state}/osascript-call.txt'
answer=$(cat '${state}/default')
if [ "$answer" = unreadable ]; then echo "execution error: -1728" >&2; exit 1; fi
printf '%s\\n' "$answer"
`,
  );
  write(
    NodePath.join(bin, "open"),
    `#!/bin/sh
printf '%s %s %s %s %s\\n' "$1" "$2" "$3" "$(stat -f %Lp "$(dirname "$3")")" "$(stat -f %Lp "$3")" >> '${state}/open-calls.txt'
if grep -qx "$2" '${state}/refuse'; then exit 1; fi
(cd && pwd -P) > '${state}/home.txt'
PATH='${npxBin}':/usr/bin:/bin "$3"
`,
  );
  write(
    NodePath.join(npxBin, "npx"),
    `#!/bin/sh\n{ pwd -P; printf '%s\\n' "$@"; } > '${state}/npx-call.txt'\n`,
  );
  const read = (file: string) => {
    const path = NodePath.join(state, file);
    return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8").trimEnd() : "";
  };
  return {
    bin,
    /** Sets what macOS answers next, and clears what the last tap recorded. */
    prepare: (answer: string, refuse: ReadonlyArray<string> = []) => {
      NodeFS.writeFileSync(NodePath.join(state, "default"), answer);
      NodeFS.writeFileSync(NodePath.join(state, "refuse"), refuse.map((id) => `${id}\n`).join(""));
      for (const file of ["open-calls.txt", "npx-call.txt", "home.txt", "osascript-call.txt"])
        NodeFS.rmSync(NodePath.join(state, file), { force: true });
    },
    opens: () => (read("open-calls.txt") === "" ? [] : read("open-calls.txt").split("\n")),
    osascript: () => read("osascript-call.txt"),
    npx: () => read("npx-call.txt"),
    home: () => read("home.txt"),
  };
};

const open = async (
  { screen, browser }: { screen: Screen; browser: Browser },
  expectedToast: string,
  tap = () => screen.getByRole("button", "Open skill installer in terminal").tap(),
) => {
  const before = (await toasts(browser)).length;
  await tap();
  await expect
    .poll(async () => (await toasts(browser)).slice(before), { timeout: 15_000 })
    .toEqual([expectedToast]);
};

test(
  "the skill installer opens in the default terminal, falls back to Terminal, then says to copy",
  { timeout: 240_000 },
  async ({ app, screen, browser }: Pick<TestFixtures, "app" | "screen"> & { browser: Browser }) => {
    const name = "default-terminal";
    const fake = await startFakeGitHub(name);
    const tools = standIns(NodePath.join(fake.home, "terminal-tools"));
    const previous = process.env.PRKIT_TERMINAL_BIN;
    process.env.PRKIT_TERMINAL_BIN = tools.bin;
    try {
      const run = startFakeInstance(name, fake);
      const installer = NodePath.join(run.home, "terminal", "prkit-skill-installer");
      await emulateOsColorScheme(browser, "light");
      await browser.setViewport({ width: 1280, height: 720 });
      await app.open(run.openUrl);
      await recordToasts(browser);
      await pressShortcut(screen, browser, "Comma");
      await screen.getByRole("link", "Outside agents").tap();
      const button = screen.getByRole("button", "Open skill installer in terminal");
      await expect(button).toBeVisible({ timeout: 30_000 });
      await expect(
        screen.getByText(
          "Uses your default terminal. Change it from your terminal's menu, for example Ghostty > Make Ghostty the Default Terminal.",
        ),
      ).toBeVisible();
      await button.scrollIntoView();
      await screenshotLightAndDark(app, browser, "default-terminal-settings");
      const command = await browser.evaluate(
        () =>
          [...document.querySelectorAll("main code, main pre")]
            .map((node) => node.textContent ?? "")
            .find((text) => text.startsWith("npx skills@")) ?? "",
      );
      expect(command).toMatch(
        /^npx skills@1\.7\.2 add https:\/\/github\.com\/[^ ]+\/tree\/main\/skills --skill prkit-cli$/,
      );
      const installerWords = command.split(" ").slice(1);

      tools.prepare("com.mitchellh.ghostty");
      await open(
        { screen, browser },
        "Skill installer opened in Ghostty | It's your default terminal. You can change it from your terminal's menu.",
      );
      await app.screenshot("default-terminal-opened-ghostty");
      expect(tools.osascript().split("\n").slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
      expect(tools.osascript()).toContain('$("public.unix-executable"), $.kLSRolesShell');
      expect(tools.opens()).toEqual([`-b com.mitchellh.ghostty ${installer} 700 700`]);
      expect(tools.npx().split("\n")).toEqual([tools.home(), ...installerWords]);
      expect(NodeFS.readdirSync(NodePath.dirname(installer))).toEqual([]);

      // iTerm2's "make Terminal the default" stores the bundle id in lower case.
      tools.prepare("com.apple.terminal");
      await open(
        { screen, browser },
        "Skill installer opened in Terminal | It's your default terminal. You can change it from your terminal's menu.",
      );
      expect(tools.opens()).toEqual([`-b com.apple.Terminal ${installer} 700 700`]);

      const fallback =
        "Skill installer opened in Terminal | prkit couldn't use your default terminal.";
      for (const answer of ["com.apple.TextEdit", "dev.warp.Warp-Stable", "", "unreadable"]) {
        tools.prepare(answer);
        await open({ screen, browser }, fallback);
        expect(tools.opens(), answer).toEqual([`-b com.apple.Terminal ${installer} 700 700`]);
        expect(tools.npx().split("\n"), answer).toEqual([tools.home(), ...installerWords]);
      }

      await toastsGone(browser);
      tools.prepare("com.mitchellh.ghostty", ["com.mitchellh.ghostty"]);
      await open({ screen, browser }, fallback);
      await app.screenshot("default-terminal-opened-fallback");
      expect(tools.opens()).toEqual([
        `-b com.mitchellh.ghostty ${installer} 700 700`,
        `-b com.apple.Terminal ${installer} 700 700`,
      ]);

      await toastsGone(browser);
      tools.prepare("com.mitchellh.ghostty", ["com.mitchellh.ghostty", "com.apple.Terminal"]);
      const before = (await toasts(browser)).length;
      await button.tap();
      const failure = screen.getByRole("alert").filter({
        hasText: "prkit couldn't open your terminal. Copy the command and run it there.",
      });
      await expect(failure).toBeVisible({ timeout: 15_000 });
      expect(tools.opens()).toEqual([
        `-b com.mitchellh.ghostty ${installer} 700 700`,
        `-b com.apple.Terminal ${installer} 700 700`,
      ]);
      expect(tools.npx()).toBe("");
      expect(NodeFS.readdirSync(NodePath.dirname(installer))).toEqual([]);
      expect((await toasts(browser)).slice(before)).toEqual([]);
      const centerFailure = () =>
        browser.evaluate(() =>
          document.querySelector('main [role="alert"]')?.scrollIntoView({ block: "center" }),
        );
      await centerFailure();
      await screenshotLightAndDark(app, browser, "default-terminal-failed");
      await browser.setViewport({ width: 760, height: 720 });
      await centerFailure();
      await app.screenshot("default-terminal-failed-narrow");
      await browser.setViewport({ width: 1280, height: 720 });

      tools.prepare("com.mitchellh.ghostty");
      await open(
        { screen, browser },
        "Skill installer opened in Ghostty | It's your default terminal. You can change it from your terminal's menu.",
        () => failure.getByRole("button", "Retry").tap(),
      );
      await expect(failure).toHaveCount(0);
      expect(tools.opens()).toEqual([`-b com.mitchellh.ghostty ${installer} 700 700`]);
      expect(tools.npx().split("\n")).toEqual([tools.home(), ...installerWords]);

      // prkit only hands the installer to a terminal. It never installs a skill itself.
      expect(NodeFS.existsSync(NodePath.join(fake.home, ".agents/skills/prkit-cli"))).toBe(false);
    } finally {
      stopFakeInstance(name, { keepHome: false });
      fake.stop();
      if (previous === undefined) delete process.env.PRKIT_TERMINAL_BIN;
      else process.env.PRKIT_TERMINAL_BIN = previous;
    }
  },
);
