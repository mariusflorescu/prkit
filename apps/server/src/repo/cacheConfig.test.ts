import { describe, expect, it } from "vite-plus/test";

import { foreignConfigKeys } from "./cacheConfig.ts";

const URL = "https://github.com/acme/widgets.git";

/** What `git config --file <cache>/config --no-includes --list -z` prints for prkit's cache on a Mac. */
const OWN = [
  "core.repositoryformatversion\n0",
  "core.filemode\ntrue",
  "core.bare\ntrue",
  "core.ignorecase\ntrue",
  "core.precomposeunicode\ntrue",
  `remote.origin.url\n${URL}`,
  "remote.origin.promisor\ntrue",
  "remote.origin.partialclonefilter\nblob:none",
];
const listed = (entries: ReadonlyArray<string>) => `${entries.join("\0")}\0`;

describe("foreignConfigKeys", () => {
  it("accepts exactly what git init and prkit write", () => {
    expect(foreignConfigKeys(listed(OWN), URL)).toEqual([]);
  });

  it("accepts a case-sensitive volume's config and a registered partial clone", () => {
    expect(
      foreignConfigKeys(
        listed([
          "core.repositoryformatversion\n1",
          "core.filemode\ntrue",
          "core.bare\ntrue",
          "extensions.partialclone\norigin",
          ...OWN.slice(5),
        ]),
        URL,
      ),
    ).toEqual([]);
  });

  it.each([
    ["a harmless extra key", ["prkit.check\n1"], ["prkit.check"]],
    ["an include", ["include.path\n/tmp/evil"], ["include.path"]],
    [
      "a rewrite that would send the token elsewhere",
      ["url.https://evil.example/.insteadof\nhttps://github.com/"],
      ["url.https://evil.example/.insteadof"],
    ],
    ["a filter driver", ["filter.lfs.smudge\ntouch /tmp/x"], ["filter.lfs.smudge"]],
    ["a key with no value, git's shorthand for true", ["core.fsmonitor"], ["core.fsmonitor"]],
    ["a second url", [`remote.origin.url\n${URL}`], ["remote.origin.url"]],
    [
      "another remote's url",
      ["remote.Origin.url\nhttps://evil.example/x.git"],
      ["remote.Origin.url"],
    ],
  ])("refuses %s", (_, extra, foreign) => {
    expect(foreignConfigKeys(listed([...OWN, ...extra]), URL)).toEqual(foreign);
  });

  it("refuses a value prkit didn't write and a key of prkit's that is gone", () => {
    const changed = OWN.map((entry) =>
      entry.startsWith("remote.origin.url")
        ? "remote.origin.url\nhttps://evil.example/x.git"
        : entry,
    ).filter((entry) => !entry.startsWith("remote.origin.promisor"));
    expect(foreignConfigKeys(listed(changed), URL)).toEqual([
      "remote.origin.url",
      "remote.origin.promisor",
    ]);
    expect(
      foreignConfigKeys(
        listed(OWN.map((entry) => (entry === "core.bare\ntrue" ? "core.bare\nfalse" : entry))),
        URL,
      ),
    ).toEqual(["core.bare"]);
  });
});
