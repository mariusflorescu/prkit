import { describe, expect, it } from "vite-plus/test";

import { describeCommand } from "./commandReads.ts";

const ROOT = "/home/me/.prkit/worktrees/r1/";
const show = (path: string) => (path.startsWith(ROOT) ? path.slice(ROOT.length) : path);

describe("describeCommand", () => {
  it("labels a read with the path relative to the checkout, not the raw command", () => {
    expect(describeCommand(`cat ${ROOT}src/store.js`, show)).toEqual({
      label: "Read src/store.js",
      reads: [{ path: `${ROOT}src/store.js`, lines: { _tag: "all" } }],
    });
  });

  it("unwraps a login shell and keeps the printed line range", () => {
    expect(
      describeCommand(`/bin/zsh -lc "sed -n '120,240p' ${ROOT}pull-request.diff"`, show),
    ).toEqual({
      label: "Read pull-request.diff, lines 120-240",
      reads: [{ path: `${ROOT}pull-request.diff`, lines: { _tag: "range", start: 120, end: 240 } }],
    });
  });

  it("narrows a numbered listing piped into head", () => {
    expect(describeCommand("nl -ba src/a.ts | head -n 80", show)?.reads).toEqual([
      { path: "src/a.ts", lines: { _tag: "range", start: 1, end: 80 } },
    ]);
  });

  it("reads the path out of git show rev:path and git diff -- path", () => {
    expect(describeCommand("git show abc1234:src/a.ts", show)).toEqual({
      label: "Read the earlier version of src/a.ts",
      reads: [{ path: "src/a.ts", lines: { _tag: "all" } }],
    });
    expect(describeCommand("git diff abc1234 HEAD -- src/a.ts src/b.ts", show)?.label).toBe(
      "Read the change to src/a.ts, src/b.ts",
    );
  });

  it("names a search without counting it as a read", () => {
    expect(describeCommand(`cd ${ROOT} && rg -n validateUrl src`, show)).toEqual({
      label: "Searched for validateUrl in src",
      reads: [],
    });
  });

  it("refuses what it can't parse", () => {
    expect(describeCommand("cat $(ls)", show)).toBeNull();
  });
});
