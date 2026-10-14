/** One-click sets of Global ignore rules. Each adds ordinary rules the user can edit or delete. */
export const IGNORE_PRESETS = [
  {
    name: "Lockfiles",
    patterns: [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "Cargo.lock",
      "Gemfile.lock",
      "poetry.lock",
      "uv.lock",
      "composer.lock",
      "go.sum",
    ],
  },
  { name: "Snapshots", patterns: ["__snapshots__/", "*.snap"] },
  { name: "Build output", patterns: ["dist/", "build/", "out/", ".next/", "coverage/"] },
  {
    name: "Generated code",
    patterns: [
      "generated/",
      "__generated__/",
      "*.generated.*",
      "*.gen.*",
      "*.pb.go",
      "*_pb2.py",
      "*.min.js",
    ],
  },
  {
    name: "Tests",
    patterns: [
      "test/",
      "tests/",
      "__tests__/",
      "*.test.*",
      "*.spec.*",
      "*_test.go",
      "test_*.py",
      "*_test.py",
    ],
  },
] as const;

/** Focus areas to start from. None is on until the user adds it. */
export const FOCUS_SUGGESTIONS = [
  {
    label: "Security",
    question: "Is any input trusted without checks, or any secret exposed?",
  },
  {
    label: "Performance",
    question: "Does anything get slower, run more often, or load more than it needs?",
  },
  {
    label: "Migrations and data",
    question: "Can the migrations run twice safely, and does existing data still read correctly?",
  },
  {
    label: "Public API compatibility",
    question: "Does any public API, schema or config change in a way callers would notice?",
  },
  {
    label: "Error handling",
    question: "What happens when a call fails, and does the user see something they can act on?",
  },
  {
    label: "Accessibility",
    question:
      "Can every new control be reached and understood with a keyboard and a screen reader?",
  },
  {
    label: "Test quality",
    question: "Do the tests check behavior a user would notice, and would they fail if it broke?",
  },
] as const;
