import type { DiffFile, DiffSnapshot } from "./diffSnapshot.ts";
import type { EffectiveIgnoreRule, RiskSignal, SkippedFile } from "./guideConfig.ts";
import { sensitiveMatcher } from "./guideConfigResolve.ts";

export interface RiskSignalInput {
  /** The files the guide reviews: what the ignore rules skip is left out. */
  readonly reviewed: DiffSnapshot;
  /**
   * What the ignore rules skip. Never evidence, but a claim that something is absent must
   * count them: a test change the reviewer chose to skip is still a test change.
   */
  readonly skipped: ReadonlyArray<SkippedFile>;
  readonly sensitive: ReadonlyArray<EffectiveIgnoreRule>;
}

// The detectors were tuned on a few hundred real pull requests. Each rule is as narrow as
// it is so that routine changes (a script in package.json, a skip in a new test) stay quiet.

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "podfile.lock",
  "package.resolved",
  "mix.lock",
  "pubspec.lock",
  "flake.lock",
  "gradle.lockfile",
  "packages.lock.json",
  "deno.lock",
]);
const isLockfile = (path: string) => LOCKFILES.has(basename(path).toLowerCase());

const TEST_FOLDERS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "testdata",
  "__mocks__",
  "fixtures",
  "__fixtures__",
  "testing",
  "testutils",
  "test_utils",
  "test-utils",
  "mdtest",
  "snapshots",
  "__snapshots__",
]);
const TEST_NAME =
  /[._-](test|spec|e2e)\.[a-z0-9]+$|^test_[^/]*\.py$|_test\.(go|py|rb|exs|rs)$|_spec\.rb$|(Test|Tests|Spec|IT)\.(java|kt|kts|swift|cs|scala|php)$|\.snap$/u;
const isTest = (path: string) =>
  path
    .toLowerCase()
    .split("/")
    .slice(0, -1)
    .some((folder) => TEST_FOLDERS.has(folder)) || TEST_NAME.test(basename(path));

const CODE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|scala|cs|fs|php|ex|exs|erl|clj|c|cc|cpp|cxx|h|hpp|m|mm|vue|svelte|dart|lua|zig|sh|bash)$/iu;
const GENERATED =
  /(^|\/)(generated|__generated__|dist|build|vendor|node_modules)\/|\.(gen|generated|min)\.[a-z]+$|\.pb\.go$|_pb2\.py$|\.d\.ts$/iu;
const isCode = (path: string) => CODE.test(path) && !GENERATED.test(path);

const MIGRATION_FOLDERS = new Set([
  "migrations",
  "migration",
  "migrate",
  "post_migrate",
  "versions",
]);
const SCHEMA_FILES = new Set(["schema.prisma", "schema.rb", "structure.sql"]);
const MIGRATION_PREFIX = /^(v?\d+[_.-]|\d{8,})/iu;
const isMigration = (path: string) => {
  if (isTest(path)) return false;
  const parts = path.split("/");
  const name = basename(path).toLowerCase();
  if (SCHEMA_FILES.has(name) || /(^|\/)prisma\/schema\/[^/]+\.prisma$/u.test(path)) return true;
  const folder = parts.findIndex((part) => MIGRATION_FOLDERS.has(part.toLowerCase()));
  if (folder === -1 || folder === parts.length - 1)
    return name.endsWith(".sql") && MIGRATION_PREFIX.test(name);
  return (
    parts.slice(folder + 1).some((part) => MIGRATION_PREFIX.test(part)) || name === "migration.sql"
  );
};

const CI =
  /^(\.github\/workflows\/|\.github\/actions\/|\.circleci\/|\.buildkite\/|\.gitlab-ci\.yml$|\.gitlab\/ci\/|Jenkinsfile|azure-pipelines\.ya?ml$|\.travis\.yml$|bitbucket-pipelines\.yml$|\.drone\.yml$|\.woodpecker)/u;

const changedLines = (file: DiffFile) => {
  const added: Array<string> = [];
  const removed: Array<string> = [];
  if (file.patch._tag !== "text") return { added, removed };
  for (const line of file.patch.patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
};

const MANIFESTS: ReadonlyArray<{ readonly name: RegExp; readonly entry: RegExp }> = [
  {
    name: /^(package|composer)\.json$/u,
    entry:
      /^\s*"(?!version"|name"|description"|main"|types"|module")[^"]+"\s*:\s*"(\^|~|>|<|=|\d|workspace:|catalog:|npm:|file:|link:|git|github:|latest$|\*)/u,
  },
  {
    name: /^pnpm-workspace\.yaml$/u,
    entry: /^\s*['"]?[@\w./-]+['"]?\s*:\s*['"]?(\^|~|>|<|=|\d|npm:)/u,
  },
  {
    name: /^(Cargo|pyproject)\.toml$/u,
    entry: /^\s*[\w.-]+\s*=\s*(\{.*version|"(\^|~|>|<|=|\d))|^\s*"[\w.[\]-]+\s*(>=|==|~=|<|>|\^)/u,
  },
  { name: /\.gemspec$/u, entry: /add_(runtime_|development_)?dependency/u },
  { name: /^pom\.xml$/u, entry: /<(version|artifactId)>/u },
  {
    name: /^build\.gradle(\.kts)?$/u,
    entry: /(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?["']/u,
  },
  { name: /^Package\.swift$/u, entry: /\.package\(/u },
  { name: /^mix\.exs$/u, entry: /\{:\w+,\s*"/u },
  { name: /\.csproj$|^Directory\.Packages\.props$/u, entry: /PackageReference|PackageVersion/u },
];
/** Files that list nothing but dependencies, so any change to them is one. */
const DEPENDENCY_LISTS =
  /^(go\.mod|Gemfile|Pipfile|Podfile|requirements[^/]*\.txt|constraints[^/]*\.txt)$/u;
const changesDependencies = (file: DiffFile) => {
  if (isLockfile(file.path) || DEPENDENCY_LISTS.test(basename(file.path))) return true;
  const manifest = MANIFESTS.find((candidate) => candidate.name.test(basename(file.path)));
  if (manifest === undefined) return false;
  const { entry } = manifest;
  const { added, removed } = changedLines(file);
  return [...added, ...removed].some((line) => entry.test(line));
};

const ASSERTION =
  /\b(expect|assert\w*|assert_eq!|assert_ne!|assert!|XCTAssert\w*|require\.\w+)\s*[(!.]|\.should\b|\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)\(|\bself\.assert\w+\(|\bassertThat\(/u;
const SKIP =
  /\b(it|test|describe|context|suite)\.(skip|todo|only)\(|\bx(it|describe|test)\(|@(Disabled|Ignore)\b|pytest\.mark\.(skip|xfail)|@unittest\.skip|\bt\.Skip(Now|f)?\(|#\[ignore\]|\bskip\s*:\s*true/u;
const INLINE_RUST_TEST = /#\[(test|cfg\(test\))\]/u;

const countMatching = (lines: ReadonlyArray<string>, pattern: RegExp) =>
  lines.filter((line) => pattern.test(line)).length;

const LARGE_LINES = 400;
const LARGE_FILES = 30;
const ASSERTIONS_DROPPED_MIN = 3;

const fewerChecks = (files: ReadonlyArray<DiffFile>): RiskSignal | null => {
  const tests = files.filter((file) => isTest(file.path));
  const deleted = tests.filter((file) => file.status === "removed");
  const added = tests.filter((file) => file.status === "added").length;
  const counted = tests.map((file) => {
    const lines = changedLines(file);
    return {
      file,
      assertionsRemoved: countMatching(lines.removed, ASSERTION),
      assertionsAdded: countMatching(lines.added, ASSERTION),
      // A new test file can't skip a test that ran before.
      skipsAdded:
        file.status === "added"
          ? 0
          : countMatching(lines.added, SKIP) - countMatching(lines.removed, SKIP),
    };
  });
  const sum = (key: "assertionsRemoved" | "assertionsAdded" | "skipsAdded") =>
    counted.reduce((total, entry) => total + entry[key], 0);
  const deletes = deleted.length > added;
  const assertions = sum("assertionsRemoved") - sum("assertionsAdded") >= ASSERTIONS_DROPPED_MIN;
  const skips = sum("skipsAdded") > 0;
  if (!deletes && !assertions && !skips) return null;
  const contributed = new Set([
    ...(deletes ? deleted : []),
    ...counted.flatMap((entry) =>
      (assertions && entry.assertionsRemoved > entry.assertionsAdded) ||
      (skips && entry.skipsAdded > 0)
        ? [entry.file]
        : [],
    ),
  ]);
  return {
    _tag: "fewer-checks",
    files: tests.filter((file) => contributed.has(file)).map((file) => file.path),
    deletedTests: deletes ? deleted.length : 0,
    assertionsRemoved: assertions ? sum("assertionsRemoved") : 0,
    assertionsAdded: assertions ? sum("assertionsAdded") : 0,
    skipsAdded: skips ? sum("skipsAdded") : 0,
  };
};

const untested = (
  files: ReadonlyArray<DiffFile>,
  skipped: ReadonlyArray<SkippedFile>,
): RiskSignal | null => {
  const code = files.filter(
    (file) => isCode(file.path) && !isTest(file.path) && file.additions + file.deletions > 0,
  );
  if (code.length === 0) return null;
  if ([...files, ...skipped].some((file) => isTest(file.path))) return null;
  if (code.some((file) => changedLines(file).added.some((line) => INLINE_RUST_TEST.test(line))))
    return null;
  return { _tag: "untested", files: code.map((file) => file.path) };
};

const large = (files: ReadonlyArray<DiffFile>): RiskSignal | null => {
  const sized = files.filter((file) => !isLockfile(file.path) && !GENERATED.test(file.path));
  const lines = sized.reduce((total, file) => total + file.additions + file.deletions, 0);
  return lines >= LARGE_LINES || sized.length >= LARGE_FILES
    ? { _tag: "large", lines, fileCount: sized.length }
    : null;
};

const pathsOf = (files: ReadonlyArray<DiffFile>, test: (file: DiffFile) => boolean) =>
  files.filter(test).map((file) => file.path);

/**
 * What prkit found in the reviewed files, in a fixed order: sensitive, migration,
 * dependencies, ci, fewer-checks, untested, large. Files keep the diff's order.
 */
export const riskSignals = (input: RiskSignalInput): ReadonlyArray<RiskSignal> => {
  const files = input.reviewed.files;
  const match = sensitiveMatcher(input.sensitive);
  const sensitive = files.flatMap((file) => {
    const matched = match(file);
    return matched === null
      ? []
      : [{ path: file.path, pattern: matched.pattern, scope: matched.scope }];
  });
  const byPath = (
    _tag: "migration" | "dependencies" | "ci",
    paths: ReadonlyArray<string>,
  ): RiskSignal | null => (paths.length === 0 ? null : { _tag, files: paths });
  return [
    sensitive.length === 0 ? null : { _tag: "sensitive" as const, files: sensitive },
    byPath(
      "migration",
      pathsOf(files, (file) => isMigration(file.path)),
    ),
    byPath("dependencies", pathsOf(files, changesDependencies)),
    byPath(
      "ci",
      pathsOf(files, (file) => CI.test(file.path)),
    ),
    fewerChecks(files),
    untested(files, input.skipped),
    large(files),
  ].filter((signal) => signal !== null);
};

const plural = (count: number, noun: string) =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

/** The plain words for one signal, shared by the agent's prompt and the guide. */
export const describeSignal = (
  signal: RiskSignal,
): { readonly label: string; readonly text: string } => {
  switch (signal._tag) {
    case "sensitive":
      return {
        label: "Look closely",
        text: `${plural(signal.files.length, "file")} ${signal.files.length === 1 ? "matches" : "match"} paths you always look closely at.`,
      };
    case "migration":
      return {
        label: "Migration",
        text: `Changes a database migration or schema: ${plural(signal.files.length, "file")}.`,
      };
    case "dependencies":
      return {
        label: "Dependencies",
        text: `Changes dependencies or a lockfile: ${plural(signal.files.length, "file")}.`,
      };
    case "ci":
      return {
        label: "CI config",
        text: `Changes how CI runs: ${plural(signal.files.length, "file")}.`,
      };
    case "fewer-checks": {
      const parts = [
        signal.deletedTests > 0 ? `deletes ${plural(signal.deletedTests, "test file")}` : null,
        signal.assertionsRemoved > signal.assertionsAdded
          ? `${plural(signal.assertionsRemoved - signal.assertionsAdded, "fewer assertion")}`
          : null,
        signal.skipsAdded > 0 ? `skips ${plural(signal.skipsAdded, "test")}` : null,
      ].filter((part) => part !== null);
      return { label: "Fewer checks", text: `Removes or skips tests: ${parts.join(", ")}.` };
    }
    case "untested":
      return {
        label: "No test changes",
        text: `Changes code in ${plural(signal.files.length, "file")} and no test file.`,
      };
    case "large":
      return {
        label: "Large",
        text: `Changes ${plural(signal.lines, "line")} in ${plural(signal.fileCount, "file")}, not counting lockfiles and generated files.`,
      };
  }
};

/** The files a signal names, each one a reviewed file. `large` names none. */
export const signalFiles = (signal: RiskSignal): ReadonlyArray<string> => {
  switch (signal._tag) {
    case "sensitive":
      return signal.files.map((file) => file.path);
    case "large":
      return [];
    default:
      return signal.files;
  }
};
