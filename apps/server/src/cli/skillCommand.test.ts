// @effect-diagnostics nodeBuiltinImport:off -- The installer script runs for real, from a folder whose name holds shell syntax.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";
import { skillInstallerScript, skillInstallWords } from "./skillCommand.ts";

it("pins the remote skill to the build commit and refuses shell input in build metadata", () => {
  const ref = "a".repeat(40);
  expect(skillInstallWords("acme/widgets", ref)?.join(" ")).toBe(
    `npx skills@1.7.2 add https://github.com/acme/widgets/tree/${ref}/skills --skill prkit-cli`,
  );
  expect(skillInstallWords("acme/widgets;touch /tmp/no", ref)).toBeNull();
  expect(skillInstallWords("acme/widgets", "$(echo no)")).toBeNull();
});

it("runs the installer's words as written, from home, and removes itself first", () => {
  const root = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-")));
  try {
    const folder = NodePath.join(root, `it's "$(touch made)" \`touch made\``);
    const bin = NodePath.join(root, "bin");
    const log = NodePath.join(root, "npx-call.txt");
    NodeFs.mkdirSync(folder);
    NodeFs.mkdirSync(bin);
    NodeFs.writeFileSync(
      NodePath.join(bin, "npx"),
      `#!/bin/sh\n{ pwd; [ -e "$INSTALLER" ] && echo still-there; printf '%s\\n' "$@"; } > "$LOG"\n`,
      { mode: 0o700 },
    );
    const file = NodePath.join(folder, "prkit-skill-installer");
    const words = ["npx", "skills@1.7.2", "it's $(touch made)", "`touch made`", "--skill"];
    NodeFs.writeFileSync(file, skillInstallerScript(words), { mode: 0o700 });
    const result = NodeChildProcess.spawnSync(file, {
      cwd: folder,
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, LOG: log, INSTALLER: file },
    });
    expect(result.stderr).toBe("");
    expect(NodeFs.readFileSync(log, "utf8").trimEnd().split("\n")).toEqual([
      root,
      ...words.slice(1),
    ]);
    expect(NodeFs.readdirSync(folder)).toEqual([]);
    expect(NodeFs.existsSync(NodePath.join(root, "made"))).toBe(false);
  } finally {
    NodeFs.rmSync(root, { recursive: true, force: true });
  }
});
