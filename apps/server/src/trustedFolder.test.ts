// @effect-diagnostics nodeBuiltinImport:off -- Real path components exercise root aliases, sticky directories and missing-folder checks.
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";

import { trustedFolderProblem } from "./trustedFolder.ts";

const withFolder = async (test: (folder: string) => Promise<void>) => {
  const directory = NodePath.resolve(".e2e/unit-trusted-folders");
  NodeFs.mkdirSync(directory, { recursive: true });
  const folder = NodeFs.mkdtempSync(NodePath.join(directory, "folder-"));
  vi.stubEnv("HOME", folder);
  vi.stubEnv("PRKIT_CLI_INSTALL_PATH", NodePath.join(folder, "bin/prkit"));
  try {
    await test(folder);
  } finally {
    vi.unstubAllEnvs();
    NodeFs.rmSync(folder, { recursive: true, force: true });
  }
};

it("accepts an owned folder behind trusted root and user ancestors", () =>
  withFolder(async (folder) => {
    expect(await Effect.runPromise(trustedFolderProblem(folder))).toBe(null);
  }));

it("checks existing ancestors before allowing a missing suffix without creating it", () =>
  withFolder(async (folder) => {
    const missing = NodePath.join(folder, "missing/bin");
    expect(await Effect.runPromise(trustedFolderProblem(missing, { allowMissing: true }))).toBe(
      null,
    );
    expect(NodeFs.existsSync(NodePath.join(folder, "missing"))).toBe(false);
    NodeFs.chmodSync(folder, 0o775);
    expect(await Effect.runPromise(trustedFolderProblem(missing, { allowMissing: true }))).toBe(
      `prkit can't use ${folder}: it is writable by group or others.`,
    );
  }));

it("requires an existing final folder when creation isn't allowed", () =>
  withFolder(async (folder) => {
    const missing = NodePath.join(folder, "missing/bin");
    expect(await Effect.runPromise(trustedFolderProblem(missing))).toBe(
      `prkit can't inspect ${NodePath.join(folder, "missing")}. Check its permissions and retry.`,
    );
  }));

it("rejects a file in a folder path", () =>
  withFolder(async (folder) => {
    const file = NodePath.join(folder, "file");
    NodeFs.writeFileSync(file, "leave me alone\n");
    expect(
      await Effect.runPromise(
        trustedFolderProblem(NodePath.join(file, "bin"), { allowMissing: true }),
      ),
    ).toBe(`prkit can't use ${file}: it isn't a real folder.`);
    expect(NodeFs.readFileSync(file, "utf8")).toBe("leave me alone\n");
  }));

it.skipIf(process.getuid?.() === 0)(
  "does not accept the sticky exception for a non-root owner",
  () =>
    withFolder(async (folder) => {
      NodeFs.chmodSync(folder, 0o1777);
      expect(await Effect.runPromise(trustedFolderProblem(folder))).toBe(
        `prkit can't use ${folder}: it is writable by group or others.`,
      );
    }),
);

it("allows root-owned sticky ancestors and macOS root-owned aliases", () =>
  withFolder(async (folder) => {
    // Only inspect missing paths through system directories; all fixtures are in .e2e.
    for (const root of ["/tmp", "/var"]) {
      const missing = NodePath.join(root, `prkit-${NodePath.basename(folder)}`);
      expect(NodeFs.existsSync(missing)).toBe(false);
      expect(await Effect.runPromise(trustedFolderProblem(missing, { allowMissing: true }))).toBe(
        null,
      );
      expect(NodeFs.existsSync(missing)).toBe(false);
    }
  }));

it.skipIf(process.getuid?.() === 0)(
  "requires ownership of the final folder even for root",
  async () => {
    expect(await Effect.runPromise(trustedFolderProblem("/"))).toBe(
      "prkit can't use /: it isn't owned by the current user.",
    );
  },
);
