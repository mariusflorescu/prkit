import { describe, expect, it } from "vite-plus/test";

import { BlobId } from "../src/diffSnapshot.ts";
import {
  compareVersions,
  fileReviewState,
  fileVersion,
  indexMarks,
  type ReviewableFile,
} from "../src/reviewedFiles.ts";
import { fnv1a64 } from "../src/textHash.ts";

const blob = BlobId.make;
const version = (patch: ReviewableFile["patch"], end: string | null = "b1") => {
  const found = fileVersion({
    path: "src/limits.ts",
    previousPath: null,
    status: "modified",
    patch,
    blob: end === null ? null : blob(end),
  });
  if (found === null) throw new Error("expected a version");
  return found;
};
const text = (patch: string) => ({ _tag: "text" as const, patch });

// The same change as GitHub's files API sends it and as `git diff` writes it.
const fromGitHub =
  "@@ -1,4 +1,5 @@ export const limits = {\n-  url: 1024,\n+  url: 2048,\n+  slug: 64,\n   title: 120,\n };";
const fromGit = [
  "diff --git a/src/limits.ts b/src/limits.ts",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/limits.ts",
  "+++ b/src/limits.ts",
  "@@ -1,4 +1,5 @@",
  "-  url: 1024,",
  "+  url: 2048,",
  "+  slug: 64,",
  "   title: 120,",
  " };",
  "",
].join("\n");

describe("a file's version", () => {
  it("is the same from GitHub's files API and from git, and after a base merge moves its lines", () => {
    const shifted = fromGitHub.replace("@@ -1,4 +1,5 @@", "@@ -9,4 +9,5 @@");
    expect(compareVersions(version(text(fromGitHub)), version(text(fromGit), "b2"))).toBe("same");
    expect(compareVersions(version(text(fromGitHub)), version(text(shifted), "b2"))).toBe("same");
  });

  it("changes with any line the reviewer read, even when the file ends the same", () => {
    const edited = fromGitHub.replace("slug: 64", "slug: 80");
    const context = fromGitHub.replace("title: 120", "title: 140");
    expect(compareVersions(version(text(fromGitHub)), version(text(edited)))).toBe("different");
    expect(compareVersions(version(text(fromGitHub)), version(text(context)))).toBe("different");
  });

  it("compares by how the file ends when either side has no hunks", () => {
    const tooLarge = version({ _tag: "too-large", lines: 4_000 });
    expect(compareVersions(tooLarge, version(text(fromGit)))).toBe("same");
    expect(compareVersions(version({ _tag: "binary" }), version({ _tag: "binary" }, "b2"))).toBe(
      "different",
    );
    // A rename alone: GitHub sends no patch, git only headers.
    expect(compareVersions(version(text("")), version(text("diff --git a/x b/y\n")))).toBe("same");
  });

  it("can't be compared between a guide stored before blob ids and a file GitHub sent no patch for", () => {
    const stored = version(text(fromGit), null);
    const live: ReviewableFile = {
      path: "src/limits.ts",
      previousPath: null,
      status: "modified",
      patch: { _tag: "too-large", lines: 4_000 },
      blob: blob("b9"),
    };
    const liveVersion = fileVersion(live);
    if (liveVersion === null) throw new Error("expected a version");
    expect(compareVersions(stored, liveVersion)).toBe("unknown");
    const marks = indexMarks({
      marks: [{ path: "src/limits.ts", version: stored, reviewed: true, order: 1 }],
    });
    expect(fileReviewState(live, marks)).toBe("unreviewed");
  });

  it("has none for a stored binary file without its blob", () => {
    expect(
      fileVersion({
        path: "logo.png",
        previousPath: null,
        status: "modified",
        patch: { _tag: "binary" },
      }),
    ).toBeNull();
  });
});

describe("fnv1a64", () => {
  it("matches FNV-1a 64's published values, which stored guide settings hashes rely on", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });
});
