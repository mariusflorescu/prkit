import { describe, expect, it } from "vite-plus/test";

import { linksRefusal, type NewLink, newLinks } from "./links.ts";

// What git prints for a fix that deleted the link `linked`, added the link `newlink`,
// pointed `notes.md` somewhere else and edited `readme.md`.
const FIX =
  ":120000 000000 8112018 0000000 D\0linked\0:000000 120000 0000000 d2001d9 A\0newlink\0:120000 120000 3b5640e 2d1adc7 M\0notes.md\0:100644 100644 ce01362 33a2a3f M\0readme.md\0";

// A fix that added the submodule `vendor/new`, pointed `vendor/lib` at another commit,
// removed `vendor/old` and turned `tools/run.sh` into a submodule.
const SUBMODULES =
  ":000000 160000 0000000 a7a4aea A\0vendor/new\0:160000 160000 1111111 2222222 M\0vendor/lib\0:160000 000000 3333333 0000000 D\0vendor/old\0:100755 160000 ce01362 4444444 T\0tools/run.sh\0";

const symlink = (path: string): NewLink => ({ path, kind: "symlink" });
const submodule = (path: string): NewLink => ({ path, kind: "submodule" });

describe("newLinks", () => {
  it("refuses a link the agent added or changed, and nothing it deleted or edited", () => {
    expect(newLinks([FIX])).toEqual([symlink("newlink"), symlink("notes.md")]);
  });

  it("refuses a file the agent turned into a link", () => {
    expect(newLinks([":100644 120000 ce01362 2d1adc7 T\0src/a.js\0"])).toEqual([
      symlink("src/a.js"),
    ]);
  });

  it("refuses a submodule the agent added, repointed or made from a file, not one it removed", () => {
    expect(newLinks([SUBMODULES])).toEqual([
      submodule("vendor/new"),
      submodule("vendor/lib"),
      submodule("tools/run.sh"),
    ]);
  });

  it("keeps a link one of a merge's sides already has", () => {
    // Against the head the base's new link shows up; against the base it doesn't.
    const againstHead = ":000000 120000 0000000 d2001d9 A\0docs/latest\0";
    const againstBase = ":100644 100644 ce01362 33a2a3f M\0src/config.js\0";
    expect(newLinks([againstHead, againstBase])).toEqual([]);
    expect(newLinks([againstHead, againstHead])).toEqual([symlink("docs/latest")]);
  });

  it("keeps a submodule one of a merge's sides already has", () => {
    const againstHead = ":000000 160000 0000000 a7a4aea A\0vendor/lib\0";
    const againstBase = ":100644 100644 ce01362 33a2a3f M\0src/config.js\0";
    expect(newLinks([againstHead, againstBase])).toEqual([]);
  });

  it("finds nothing in an empty diff", () => {
    expect(newLinks([""])).toEqual([]);
  });
});

describe("linksRefusal", () => {
  it("names the links, the submodules, or both", () => {
    expect(linksRefusal([symlink("notes.md")])).toBe(
      "The agent made or changed the symlink notes.md. prkit never commits a link an agent wrote, because it could point anywhere on your machine, so nothing was committed.",
    );
    expect(linksRefusal([submodule("vendor/a"), submodule("vendor/b")])).toBe(
      "The agent made or changed the submodules vendor/a, vendor/b. prkit never commits a submodule an agent wrote, because git would read another repository there, so nothing was committed.",
    );
    expect(linksRefusal([symlink("notes.md"), submodule("vendor/a")])).toBe(
      "The agent made or changed the symlink notes.md and the submodule vendor/a. prkit never commits either from an agent, because a link could point anywhere on your machine and a submodule makes git read another repository, so nothing was committed.",
    );
  });
});
