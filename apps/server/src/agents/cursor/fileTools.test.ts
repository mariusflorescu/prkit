// @effect-diagnostics-next-line nodeBuiltinImport:off -- the tools read with Node's own calls; the test checks what they left on disk
import * as NodeFs from "node:fs/promises";

import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeTestCheckout, removeTestCheckout } from "../testCheckout.ts";
import { type FileTool, makeFileTools, MAX_FILE_BYTES, writeNoFollow } from "./fileTools.ts";

let at: Effect.Success<ReturnType<typeof makeTestCheckout>>;
let checkout = "";
let readTools: Record<string, FileTool> = {};
let writeTools: Record<string, FileTool> = {};

beforeAll(async () => {
  at = await Effect.runPromise(makeTestCheckout());
  checkout = await NodeFs.realpath(at.checkout);
  readTools = makeFileTools({ checkout, paths: at.paths, writes: false });
  writeTools = makeFileTools({ checkout, paths: at.paths, writes: true });
  await NodeFs.writeFile(`${checkout}/big.txt`, "x".repeat(MAX_FILE_BYTES + 1));
  await NodeFs.writeFile(`${checkout}/image.png`, Buffer.from([0x89, 0x50, 0x00, 0x47]));
  await NodeFs.writeFile(`${checkout}/src/twice.js`, "a;\na;\n");
});
afterAll(() => Effect.runPromise(removeTestCheckout(at.root)));

const use = async (
  tools: Record<string, FileTool>,
  name: string,
  args: Record<string, string | boolean>,
) => {
  const tool = tools[name];
  if (tool === undefined) throw new Error(`no ${name}`);
  const result = await tool.run(args);
  // A refusal never names a place outside the checkout.
  expect(result.text).not.toContain(at.outside);
  expect(result.text).not.toContain("secret");
  return result;
};

describe("prkit's file tools for Cursor", () => {
  it("gives a guide reading tools only, and a fix writing too", () => {
    expect(Object.keys(readTools)).toEqual(["read_file", "list_dir", "glob", "grep"]);
    expect(Object.keys(writeTools)).toEqual([
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "write_file",
      "edit_file",
    ]);
  });

  it("reads files in the checkout and the extra readable folder, by relative or absolute path", async () => {
    expect(await use(readTools, "read_file", { path: "src/a.js" })).toEqual({
      ok: true,
      text: "export {};\n",
    });
    expect((await use(readTools, "read_file", { path: `${checkout}/src/a.js` })).ok).toBe(true);
    // A link that stays in the checkout is followed.
    expect((await use(readTools, "read_file", { path: "inner/a.js" })).ok).toBe(true);
    expect((await use(readTools, "read_file", { path: `${at.diffs}/numbered.diff` })).ok).toBe(
      true,
    );
  });

  it("refuses to read past the checkout: .., absolute, a linked file or folder, .git", async () => {
    for (const path of [
      "../outside/secret.txt",
      `${at.outside}/secret.txt`,
      "notes.md",
      "linked/inside.txt",
      "dangling",
      ".git",
      `${at.co.gitDir}/gitdir`,
      "~/.ssh/id_ed25519",
    ])
      expect(await use(readTools, "read_file", { path }), path).toMatchObject({ ok: false });
  });

  it("refuses a file too large or binary to read", async () => {
    expect(await use(readTools, "read_file", { path: "big.txt" })).toMatchObject({
      ok: false,
      text: expect.stringContaining("too large"),
    });
    expect(await use(readTools, "read_file", { path: "image.png" })).toMatchObject({
      ok: false,
      text: expect.stringContaining("binary"),
    });
  });

  it("lists and finds files without following a link out or showing .git", async () => {
    const listed = await use(readTools, "list_dir", {});
    expect(listed.ok).toBe(true);
    expect(listed.text.split("\n")).toEqual(
      expect.arrayContaining(["src/", "notes.md@", "linked@"]),
    );
    expect(listed.text).not.toContain(".git");
    for (const path of ["..", "linked", at.outside, ".git"])
      expect(await use(readTools, "list_dir", { path }), path).toMatchObject({ ok: false });

    const found = await use(readTools, "glob", { pattern: "**/*.txt" });
    expect(found.text.split("\n")).toEqual(["big.txt", "opts/a.txt"]);
    for (const args of [{ pattern: "../**" }, { pattern: "*", path: "linked" }])
      expect(await use(readTools, "glob", args)).toMatchObject({ ok: false });
  });

  it("searches only files that stay in the checkout", async () => {
    expect(await use(readTools, "grep", { pattern: "secret" })).toEqual({
      ok: true,
      text: "No matches.",
    });
    expect(await use(readTools, "grep", { pattern: "export", glob: "src/*.js" })).toEqual({
      ok: true,
      text: "src/a.js:1: export {};\nsrc/b.js:1: export {};",
    });
    for (const path of ["notes.md", "linked", "..", at.outside])
      expect(await use(readTools, "grep", { pattern: "s", path }), path).toMatchObject({
        ok: false,
      });
  });

  it("writes and edits files in the checkout, folders and all", async () => {
    expect(await use(writeTools, "write_file", { path: "src/new/x.ts", content: "1\n" })).toEqual({
      ok: true,
      text: "Wrote src/new/x.ts.",
    });
    expect(await NodeFs.readFile(`${checkout}/src/new/x.ts`, "utf8")).toBe("1\n");
    expect(
      await use(writeTools, "edit_file", {
        path: "src/a.js",
        old_string: "{}",
        new_string: "{ a }",
      }),
    ).toEqual({ ok: true, text: "Edited src/a.js." });
    expect(
      await use(writeTools, "edit_file", {
        path: "src/twice.js",
        old_string: "a;",
        new_string: "b;",
      }),
    ).toMatchObject({ ok: false, text: expect.stringContaining("2 times") });
    expect(
      await use(writeTools, "edit_file", {
        path: "src/twice.js",
        old_string: "a;",
        new_string: "b;",
        replace_all: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await use(writeTools, "edit_file", { path: "src/b.js", old_string: "nope", new_string: "" }),
    ).toMatchObject({ ok: false });
  });

  it("refuses to write past the checkout, through a link, into .git, .cursor or a sandbox.json", async () => {
    for (const path of [
      "../escape.txt",
      `${at.outside}/escape.txt`,
      "notes.md",
      "linked/escape.txt",
      "linked/deeper/escape.txt",
      "dangling",
      ".git",
      ".GIT/config",
      ".cursor/sandbox.json",
      ".cursor/rules/a.mdc",
      "sandbox.json",
      "src/Sandbox.json",
    ]) {
      expect(await use(writeTools, "write_file", { path, content: "x" }), path).toMatchObject({
        ok: false,
      });
      expect(
        await use(writeTools, "edit_file", { path, old_string: "secret", new_string: "x" }),
        path,
      ).toMatchObject({ ok: false });
    }
    expect(await NodeFs.readFile(`${at.outside}/secret.txt`, "utf8")).toBe("secret\n");
    expect(await NodeFs.readdir(at.outside)).toEqual(["dir", "secret.txt"]);
    expect(await NodeFs.readdir(`${at.outside}/dir`)).toEqual(["inside.txt"]);
    await expect(NodeFs.access(`${at.root}/escape.txt`)).rejects.toThrow();
    await expect(NodeFs.access(`${checkout}/.cursor`)).rejects.toThrow();
  });

  it("refuses .cursor and sandbox.json spelled so APFS opens them anyway, and leaves no folder", async () => {
    for (const path of [".curſor/ſandbox.json", ".curſor/hooks.json", ".CURSOR/x", "ſandbox.json"])
      expect(await use(writeTools, "write_file", { path, content: "{}" }), path).toMatchObject({
        ok: false,
      });
    await expect(NodeFs.stat(`${checkout}/.cursor/sandbox.json`)).rejects.toThrow();
    await expect(NodeFs.stat(`${checkout}/.cursor`)).rejects.toThrow();
    await expect(NodeFs.stat(`${checkout}/sandbox.json`)).rejects.toThrow();
  });

  // The test's own timeout is the proof it returned within seconds: unbounded, this takes minutes.
  it("stops a search whose pattern backtracks for too long, and keeps working", async () => {
    await NodeFs.writeFile(`${checkout}/slow.txt`, `${"a".repeat(40)}b\n`);
    expect(await use(readTools, "grep", { pattern: "(a+)+$", path: "slow.txt" })).toMatchObject({
      ok: false,
      text: expect.stringContaining("too slow"),
    });
    expect(await use(readTools, "grep", { pattern: "b$", path: "slow.txt" })).toEqual({
      ok: true,
      text: `slow.txt:1: ${"a".repeat(40)}b`,
    });
  }, 12_000);

  it("never writes through a link put where a file was checked", async () => {
    await NodeFs.symlink(`${at.outside}/secret.txt`, `${checkout}/swapped.txt`);
    await expect(writeNoFollow(`${checkout}/swapped.txt`, "x")).rejects.toThrow();
    expect(await NodeFs.readFile(`${at.outside}/secret.txt`, "utf8")).toBe("secret\n");
  });
});
