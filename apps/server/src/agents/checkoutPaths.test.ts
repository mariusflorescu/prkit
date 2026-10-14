import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeTestCheckout, removeTestCheckout } from "./testCheckout.ts";

// A pull request's author controls every file in the checkout, links included. These
// answers decide whether an agent's read or edit can reach anything outside it.
describe("checkoutPaths", () => {
  let checkout: Effect.Success<ReturnType<typeof makeTestCheckout>>;
  beforeAll(async () => {
    checkout = await Effect.runPromise(makeTestCheckout());
  });
  afterAll(() => Effect.runPromise(removeTestCheckout(checkout.root)));

  const answers = (target: string) =>
    Effect.runPromise(
      Effect.all([
        checkout.paths.unreadable([{ path: target, option: true }]),
        checkout.paths.writable([target]),
      ]),
    ).then(([outside, writable]) => [outside === null, writable]);

  it.each([
    ["a file inside", "src/a.js", [true, true]],
    ["a new file inside", "src/new.js", [true, true]],
    ["a link that stays inside", "inner/a.js", [true, true]],
    ["the checkout root itself", ".", [true, true]],
    ["a `..` that escapes", "../outside/secret.txt", [false, false]],
    ["a `..` that comes back", "src/../src/a.js", [false, false]],
    ["an absolute path outside", "/etc/hosts", [false, false]],
    ["a home path", "~/.ssh/id_ed25519", [false, false]],
    ["a link to a file outside", "notes.md", [false, false]],
    ["a file under a linked directory", "linked/inside.txt", [false, false]],
    ["a new file under a linked directory", "linked/new.txt", [false, false]],
    ["a link to nothing", "dangling", [false, false]],
    ["the .git link", ".git", [true, false]],
    ["the .git link in other case", ".GIT", [true, false]],
  ])("answers %s (%s) with readable and writable %j", async (_, target, expected) => {
    expect(await answers(target)).toEqual(expected);
  });

  it("judges absolute paths by where they land, whichever spelling of the checkout they use", async () => {
    expect(await answers(`${checkout.checkout}/src/a.js`)).toEqual([true, true]);
    expect(await answers(`${checkout.checkout}/linked/new.txt`)).toEqual([false, false]);
    expect(await answers(`${checkout.outside}/secret.txt`)).toEqual([false, false]);
  });

  it("lets the agent read its extra directories but never write there", async () => {
    expect(await answers(`${checkout.diffs}/numbered.diff`)).toEqual([true, false]);
  });

  // The shell expands a pattern before the command runs, so a pattern is readable only
  // if nothing it could match lands outside, as bash 3.2 and 5.3, zsh 5.9, sh and dash
  // expand it on macOS. A test checkout's root holds links that lead out.
  const reads = (target: string, from = "", option = true) =>
    Effect.runPromise(
      checkout.paths.unreadable([{ path: target, option }], `${checkout.checkout}/${from}`),
    ).then((outside) => outside === null);

  it.each([
    ["files in a folder", "src/*.ts", ""],
    ["a folder at every depth", "./**/x", "src"],
    ["alternatives", "{a,b}.txt", ""],
    ["a pattern under a link that stays inside", "inner/*", ""],
    ["brackets, which never match a leading dot", "[.][.]/x", "src"],
  ])("lets a pattern read %s (%s from /%s)", async (_, target, from) => {
    expect(await reads(target, from)).toBe(true);
  });

  it.each([
    ["the parent folder", "../*", ""],
    ["every home folder", "/Users/*/x", ""],
    ["the home folder", "~/*", ""],
    ["another user's home", "~root/x", ""],
    ["a `..` after a pattern", "src/*/../../..", ""],
    ["an alternative that climbs out", "{src,..}/x", ""],
    ["a system file", "/etc/pass?d", ""],
    ["brackets beside links that lead out", "[.][.]/x", ""],
    ["a dot pattern bash matches to `..`", ".?/x", "src"],
    ["a dot pattern bash matches to `.` and `..`", "src/.*", ""],
    ["a link to a file outside", "*.md", ""],
    ["a link to a directory outside", "l*/inside.txt", ""],
    ["every depth past a link outside", "**/inside.txt", ""],
    ["a range of alternatives", "{1..3}.txt", ""],
    ["a file named like an option", "*", "opts"],
  ])("refuses a pattern that reaches %s (%s from /%s)", async (_, target, from) => {
    expect(await reads(target, from)).toBe(false);
  });

  it("lets a pattern beside a file named like an option through only where options have ended", async () => {
    expect(await Promise.all([reads("*", "opts", true), reads("*", "opts", false)])).toEqual([
      false,
      true,
    ]);
  });

  it("refuses a pattern that would make it list more than 20,000 entries", async () => {
    const wide = `${checkout.checkout}/wide`;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const folder of ["a", "b"]) {
          yield* fs.makeDirectory(`${wide}/${folder}`, { recursive: true });
          yield* Effect.forEach(
            Array.from({ length: 10_000 }, (_, index) => index),
            (index) => fs.writeFileString(`${wide}/${folder}/${index}`, ""),
            { concurrency: 64 },
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(await Promise.all([reads("wide/a/**/x"), reads("wide/**/x")])).toEqual([true, false]);
  });
});
