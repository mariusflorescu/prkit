// @effect-diagnostics-next-line nodeBuiltinImport:off -- Build metadata comes from a read-only git command.
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The build callback writes its identity before the server runtime exists.
import { writeFileSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { defineConfig } from "vite-plus";

const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};
const remote = git("remote", "get-url", "origin");
const repository =
  process.env.GITHUB_REPOSITORY ??
  /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1] ??
  "";
const skillRef = process.env.GITHUB_ACTIONS === "true" ? git("rev-parse", "HEAD") : "main";

const buildId = String(Effect.runSync(Clock.currentTimeMillis));

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: false,
      },
    },
  },
  pack: {
    // Cursor's runner is a child process of its own (agents/cursor/CursorAgent.ts finds it here).
    entry: { bin: "src/bin.ts", cursorRunner: "src/agents/cursor/runner.ts" },
    outDir: "dist",
    sourcemap: true,
    clean: true,
    define: {
      PRKIT_BUILD_ID: JSON.stringify(buildId),
      PRKIT_SKILL_REPOSITORY: JSON.stringify(repository),
      PRKIT_SKILL_REF: JSON.stringify(skillRef),
    },
    onSuccess: () => {
      writeFileSync(new URL("./dist/build.json", import.meta.url), JSON.stringify({ buildId }));
    },
    // Read at runtime next to the bundle (Reviews.ts, Fixers.ts and Asks.ts load them from their own directory).
    copy: [
      "src/reviews/instructions.md",
      "src/fixers/fix-instructions.md",
      "src/asks/ask-instructions.md",
    ],
    // Everything but Node's builtins is inlined, so the packaged app ships one self-contained
    // server with no node_modules. The Claude Agent SDK finds its platform binary with a
    // runtime resolve the bundler never follows; prkit always passes the user's own claude.
    deps: {
      alwaysBundle: (id: string) => !id.startsWith("node:"),
      onlyBundle: false,
    },
  },
});
