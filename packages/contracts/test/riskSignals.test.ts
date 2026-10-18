import { describe, expect, it } from "vite-plus/test";

import type { DiffFile } from "../src/diffSnapshot.ts";
import { GuideItemId, type RiskSignal } from "../src/guideConfig.ts";
import { describeSignal, riskSignals, signalFiles } from "../src/riskSignals.ts";

const change = (
  path: string,
  lines: ReadonlyArray<string> = ["+const a = 1;"],
  status: DiffFile["status"] = "modified",
): DiffFile => ({
  path,
  previousPath: null,
  status,
  additions: lines.filter((line) => line.startsWith("+")).length,
  deletions: lines.filter((line) => line.startsWith("-")).length,
  patch: { _tag: "text", patch: ["@@ -1,9 +1,9 @@", ...lines].join("\n") },
});
const sized = (path: string, additions: number): DiffFile => ({ ...change(path), additions });
const fired = (files: ReadonlyArray<DiffFile>) =>
  riskSignals({ reviewed: { files }, skipped: [], sensitive: [] }).map((signal) => signal._tag);

describe("risk signals", () => {
  it.each<{
    name: string;
    files: ReadonlyArray<DiffFile>;
    tag: RiskSignal["_tag"];
    fires: boolean;
  }>([
    {
      name: "a timestamped migration",
      files: [change("db/migrate/20260728145403_add_users.rb")],
      tag: "migration",
      fires: true,
    },
    {
      name: "a numbered SQL file anywhere",
      files: [change("drizzle/0004_cool_name.sql")],
      tag: "migration",
      fires: true,
    },
    {
      name: "a Prisma schema",
      files: [change("prisma/schema.prisma")],
      tag: "migration",
      fires: true,
    },
    {
      name: "migration tooling",
      files: [change("src/migrations/runner.ts")],
      tag: "migration",
      fires: false,
    },
    {
      name: "a migration test",
      files: [change("test/migrations/0001_init.sql")],
      tag: "migration",
      fires: false,
    },
    {
      name: "a new dependency",
      files: [change("package.json", ['+    "effect": "^4.0.2",'])],
      tag: "dependencies",
      fires: true,
    },
    {
      name: "a script-only package.json",
      files: [change("package.json", ['+    "build": "vite build",'])],
      tag: "dependencies",
      fires: false,
    },
    { name: "a lockfile", files: [change("pnpm-lock.yaml")], tag: "dependencies", fires: true },
    {
      name: "any go.mod change",
      files: [change("go.mod", ["+go 1.24"])],
      tag: "dependencies",
      fires: true,
    },
    { name: "a workflow", files: [change(".github/workflows/ci.yml")], tag: "ci", fires: true },
    { name: "docs about CI", files: [change("docs/ci.md")], tag: "ci", fires: false },
    {
      name: "a skip in an existing test",
      files: [change("src/a.test.ts", ['+  it.skip("works", () => {});'])],
      tag: "fewer-checks",
      fires: true,
    },
    {
      name: "a skip in a new test file",
      files: [change("src/a.test.ts", ['+  it.skip("works", () => {});'], "added")],
      tag: "fewer-checks",
      fires: false,
    },
    {
      name: "a deleted test file",
      files: [change("tests/a.py", ["-assert a == 1"], "removed")],
      tag: "fewer-checks",
      fires: true,
    },
    {
      name: "a moved test file",
      files: [
        change("tests/a.py", ["-def test_a():"], "removed"),
        change("tests/b.py", ["+def test_a():"], "added"),
      ],
      tag: "fewer-checks",
      fires: false,
    },
    {
      name: "two fewer assertions",
      files: [change("src/a.test.ts", ["-expect(a).toBe(1);", "-expect(b).toBe(2);"])],
      tag: "fewer-checks",
      fires: false,
    },
    { name: "code with no test change", files: [change("src/a.ts")], tag: "untested", fires: true },
    {
      name: "code with its test",
      files: [change("src/a.ts"), change("src/__tests__/a.ts")],
      tag: "untested",
      fires: false,
    },
    {
      name: "Rust code with an inline test",
      files: [change("src/lib.rs", ["+#[cfg(test)]"])],
      tag: "untested",
      fires: false,
    },
    {
      name: "a change next to an existing inline Rust test",
      files: [
        change("src/lib.rs", [
          " #[cfg(test)]",
          " mod tests {",
          "-    assert_eq!(a(), 1);",
          "+    assert_eq!(a(), 2);",
        ]),
      ],
      tag: "untested",
      fires: false,
    },
    {
      name: "the package's own version in Cargo.toml",
      files: [change("Cargo.toml", [" [package]", '-version = "1.0.0"', '+version = "1.0.1"'])],
      tag: "dependencies",
      fires: false,
    },
    {
      name: "a dependency under a [dependencies] header the hunk shows",
      files: [change("Cargo.toml", [" [dependencies]", '-serde = "1.0"', '+serde = "1.1"'])],
      tag: "dependencies",
      fires: true,
    },
    {
      name: "a package.json script that runs git",
      files: [change("package.json", ['+    "check": "git diff --check",'])],
      tag: "dependencies",
      fires: false,
    },
    {
      name: "a local package in a dependencies block",
      files: [change("package.json", ['   "dependencies": {', '+    "shared": "file:../shared",'])],
      tag: "dependencies",
      fires: true,
    },
    {
      name: "versioned docs",
      files: [change("docs/versions/v2.0.md")],
      tag: "migration",
      fires: false,
    },
    {
      name: "an Alembic revision",
      files: [change("alembic/versions/3f2a9c_add_users.py")],
      tag: "migration",
      fires: true,
    },
    {
      name: "assertions joined onto one line",
      files: [
        change("src/a.test.ts", [
          "-expect(a).toBe(1);",
          "-expect(b).toBe(2);",
          "-expect(c).toBe(3);",
          "-expect(d).toBe(4);",
          "+expect(a).toBe(1); expect(b).toBe(2); expect(c).toBe(3); expect(d).toBe(4);",
        ]),
      ],
      tag: "fewer-checks",
      fires: false,
    },
    { name: "docs only", files: [change("README.md")], tag: "untested", fires: false },
    { name: "400 changed lines", files: [sized("src/a.ts", 400)], tag: "large", fires: true },
    {
      name: "a large lockfile",
      files: [sized("pnpm-lock.yaml", 900), sized("src/a.ts", 10)],
      tag: "large",
      fires: false,
    },
    {
      name: "30 files",
      files: Array.from({ length: 30 }, (_, index) => change(`docs/${index}.md`)),
      tag: "large",
      fires: true,
    },
  ])("$tag: $name", ({ files, tag, fires }) => {
    expect(fired(files).includes(tag)).toBe(fires);
  });

  it("doesn't say no test changed when the ignore rules skip the test change", () => {
    const signals = riskSignals({
      reviewed: { files: [change("src/a.ts")] },
      skipped: [
        {
          path: "test/a.test.ts",
          previousPath: null,
          additions: 3,
          deletions: 0,
          reasons: [{ path: "test/a.test.ts", pattern: "test/", scope: "global" }],
        },
      ],
      sensitive: [],
    });
    expect(signals.map((signal) => signal._tag)).not.toContain("untested");
  });

  it("lists what fired in a fixed order, each with the reviewed files that show it", () => {
    const signals = riskSignals({
      skipped: [],
      reviewed: {
        files: [
          change("src/auth/session.ts"),
          change("db/migrate/20260728145403_add_users.rb", ["+create_table :users"], "added"),
          change(".github/workflows/ci.yml"),
          change("package.json", ['+    "effect": "^4.0.2",']),
          change(
            "test/session.test.ts",
            ["-expect(a).toBe(1);", "-expect(b).toBe(2);", "-expect(c).toBe(3);", "-assert(d);"],
            "removed",
          ),
          sized("src/billing.ts", 1200),
          sized("pnpm-lock.yaml", 3000),
        ],
      },
      sensitive: [
        {
          id: GuideItemId.make("g-auth"),
          pattern: "src/auth/",
          scope: "global",
          active: true,
          decidedBy: null,
        },
      ],
    });
    expect(signals[0]).toEqual({
      _tag: "sensitive",
      files: [{ path: "src/auth/session.ts", pattern: "src/auth/", scope: "global" }],
    });
    expect(signals.map((signal) => [describeSignal(signal), signalFiles(signal)])).toEqual([
      [
        { label: "Look closely", text: "1 file matches paths you always look closely at." },
        ["src/auth/session.ts"],
      ],
      [
        { label: "Migration", text: "Changes a database migration or schema: 1 file." },
        ["db/migrate/20260728145403_add_users.rb"],
      ],
      [
        { label: "Dependencies", text: "Changes dependencies or a lockfile: 2 files." },
        ["package.json", "pnpm-lock.yaml"],
      ],
      [{ label: "CI config", text: "Changes how CI runs: 1 file." }, [".github/workflows/ci.yml"]],
      [
        {
          label: "Fewer checks",
          text: "Removes or skips tests: deletes 1 test file, 4 fewer assertions.",
        },
        ["test/session.test.ts"],
      ],
      [
        {
          label: "Large",
          text: "Changes 1,208 lines in 6 files, not counting lockfiles and generated files.",
        },
        [],
      ],
    ]);
  });
});
