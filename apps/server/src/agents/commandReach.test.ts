import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import { toolFolders, turnTmpDir } from "./commandReach.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

// A trusted fix's check scripts run node and a package manager from wherever the owner
// installed them. The sandboxes open those folders, and never the home or a folder in it.
describe("toolFolders", () => {
  it.each([
    [
      "Homebrew's node",
      "/opt/homebrew/Cellar/node/23.10.0/bin/node",
      ["/opt/homebrew/Cellar/node/23.10.0/bin", "/opt/homebrew/Cellar/node/23.10.0"],
    ],
    [
      "mise's node",
      "/Users/me/.local/share/mise/installs/node/24.21.0/bin/node",
      [
        "/Users/me/.local/share/mise/installs/node/24.21.0/bin",
        "/Users/me/.local/share/mise/installs/node/24.21.0",
      ],
    ],
    [
      "npm inside node's own install",
      "/Users/me/tools/node/lib/node_modules/npm/bin/npm-cli.js",
      [
        "/Users/me/tools/node/lib/node_modules/npm/bin",
        "/Users/me/tools/node/lib/node_modules/npm",
      ],
    ],
    ["pnpm's standalone install", "/Users/me/Library/pnpm/pnpm", ["/Users/me/Library/pnpm"]],
    ["bun, whose prefix is a folder in the home", "/Users/me/.bun/bin/bun", ["/Users/me/.bun/bin"]],
    ["a tool in the home's own bin", "/Users/me/bin/node", ["/Users/me/bin"]],
    ["a tool directly in /bin", "/bin/node", ["/bin"]],
  ])("opens %s", (_, tool, expected) => {
    expect(toolFolders(path, "/Users/me", [tool])).toEqual(expected);
  });
});

describe("turnTmpDir", () => {
  it("names the turn's folder so Claude Code's sandbox can use it, whatever the uid", () => {
    const dir = turnTmpDir(path, "4f9c2a1e-7b3d-4c55-9e01-2f6a8b7c9d0e");
    expect(dir).toBe("/Users/Shared/prkit-4f9c2a");
    // Claude Code falls back to /tmp/claude-<uid> past 44 bytes; 4294967295 is the largest uid.
    expect(Buffer.byteLength(`${dir}/claude-4294967295`)).toBeLessThanOrEqual(44);
  });
});
