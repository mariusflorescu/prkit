import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { repoRoot } from "../scripts/verify-run.ts";

/**
 * The stand-in Claude Code of scripts/fake-claude.ts, in a folder of its own: pass `file` to
 * `verify-app start --claude`. `hold` keeps its next turns writing until `release`,
 * `failing` makes them end with an error instead of a guide, and `plant` has its next fixes
 * and resolutions leave something behind (scripts/fake-claude.ts lists what).
 */
export const setUpFakeClaude = (name: string) => {
  const dir = NodePath.join(repoRoot, ".e2e", "fake", `${name}-claude`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "claude");
  const script = NodePath.join(repoRoot, "scripts", "fake-claude.ts");
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh\nFAKE_CLAUDE_DIR='${dir}' exec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o755 },
  );
  const flag = (name: "hold" | "fail", on: boolean) =>
    on
      ? NodeFS.writeFileSync(NodePath.join(dir, name), "")
      : NodeFS.rmSync(NodePath.join(dir, name), { force: true });
  return {
    file,
    hold: () => flag("hold", true),
    release: () => flag("hold", false),
    failing: (on: boolean) => flag("fail", on),
    /** `nested` takes the path for the repository; `null` stops planting it. */
    plant: (what: "nested" | "todo" | "linger", value: string | null) =>
      value === null
        ? NodeFS.rmSync(NodePath.join(dir, what), { force: true })
        : NodeFS.writeFileSync(NodePath.join(dir, what), value),
    /** The PID of the `sleep` the last `linger` turn left, or null. */
    lingering: () => {
      const file = NodePath.join(dir, "linger.pid");
      return NodeFS.existsSync(file) ? Number(NodeFS.readFileSync(file, "utf8")) : null;
    },
  };
};
