import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BlobId } from "../src/diffSnapshot.ts";
import {
  indexTicks,
  ManualCheckCode,
  manualCheckCode,
  manualCheckStepState,
  manualCheckStepVersion,
  type ManualCheckTick,
  stepFiles,
} from "../src/manualCheckTicks.ts";
import { fileVersion, type ReviewableFile } from "../src/reviewedFiles.ts";

const file = (
  path: string,
  line: string,
  extra: Partial<Pick<ReviewableFile, "status" | "previousPath">> = {},
): ReviewableFile => ({
  path,
  previousPath: null,
  status: "modified",
  patch: { _tag: "text", patch: `@@ -4,2 +4,2 @@\n-const a = 1;\n+${line}\n` },
  blob: BlobId.make(line.length.toString(16).padStart(8, "a")),
  ...extra,
});

const step = manualCheckStepVersion({ action: "Open it.", expect: "It opens." });
const chapters = [{ id: "limits", files: [{ path: "src/limits.ts" }, { path: "src/links.ts" }] }];
const filesOf = (...files: ReadonlyArray<ReviewableFile>) =>
  new Map(files.map((entry) => [entry.path, entry]));
const codeOf = (...files: ReadonlyArray<ReviewableFile>) =>
  manualCheckCode(stepFiles({ chapter: "limits" }, chapters, filesOf(...files)));

const decision = (
  order: number,
  ticked: boolean,
  code: ReturnType<typeof codeOf>,
): ManualCheckTick => ({ step, code, ticked, order });
const stateOf = (
  now: ReadonlyArray<ReviewableFile>,
  ...decisions: ReadonlyArray<ManualCheckTick>
) =>
  manualCheckStepState(
    step,
    stepFiles({ chapter: "limits" }, chapters, filesOf(...now)),
    indexTicks({ ticks: decisions }),
  );

const limits = file("src/limits.ts", "const a = 2;");
const edited = file("src/limits.ts", "const a = 22;");
const links = file("src/links.ts", "const b = 2;");

describe("a manual check tick against the code of its chapter", () => {
  it("follows the chapter's diff: a real edit changes it, a file moved into the chapter does not", () => {
    const ticked = decision(1, true, codeOf(limits));
    expect(stateOf([limits], ticked)).toBe("ticked");
    expect(stateOf([edited], ticked)).toBe("changed");
    expect(stateOf([limits, links], ticked)).toBe("ticked");
    expect(stateOf([edited, links], ticked)).toBe("changed");
  });

  it("answers from the newest decision about the same code, else about different code", () => {
    const first = decision(1, true, codeOf(limits));
    const again = decision(2, true, codeOf(edited));
    expect(stateOf([limits], first, again)).toBe("ticked");
    expect(stateOf([edited], first, again)).toBe("ticked");
    const unticked = decision(3, false, codeOf(edited));
    expect(stateOf([edited], first, again, unticked)).toBe("unticked");
    expect(stateOf([limits], first, again, unticked)).toBe("ticked");
    expect(stateOf([limits, links], decision(1, false, codeOf(limits)), again)).toBe("unticked");
  });

  it("matches a renamed file by the path it came from", () => {
    const moved = file("src/limits.ts", "const a = 2;", {
      status: "renamed",
      previousPath: "src/old-limits.ts",
    });
    const movedAndEdited = file("src/limits.ts", "const a = 22;", {
      status: "renamed",
      previousPath: "src/old-limits.ts",
    });
    const old = file("src/old-limits.ts", "const a = 2;");
    const version = fileVersion(old);
    if (version === null) throw new Error("expected a version");
    const before = decision(1, true, manualCheckCode([{ path: old.path, version }]));
    expect(stateOf([moved], before)).toBe("ticked");
    expect(stateOf([movedAndEdited], before)).toBe("changed");
  });

  it("keeps a tick that has no code, or none to compare, reading ticked", () => {
    expect(stateOf([edited], decision(1, true, null))).toBe("ticked");
    expect(stateOf([edited], decision(1, true, codeOf(links)))).toBe("ticked");
    expect(stateOf([], decision(1, true, codeOf(limits)))).toBe("ticked");
    expect(stateOf([], decision(1, true, codeOf(limits)), decision(2, false, null))).toBe(
      "unticked",
    );
  });

  it("is a non-empty list of files, each path once, in path order", () => {
    const decode = Schema.decodeUnknownSync(ManualCheckCode);
    const one = codeOf(links, limits);
    expect(one?.map((entry) => entry.path)).toEqual(["src/limits.ts", "src/links.ts"]);
    expect(() => decode([])).toThrow();
    expect(() => decode(one === null ? [] : [...one, ...one])).toThrow();
    expect(codeOf()).toBeNull();
  });
});
