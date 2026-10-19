import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { repoRoot } from "../scripts/verify-run.ts";

const Run = Schema.fromJsonString(
  Schema.Struct({
    configDir: Schema.NullOr(Schema.String),
    session: Schema.String,
    resumed: Schema.Boolean,
    forked: Schema.Boolean,
  }),
);

export type FakeManualCheck = {
  setup?: string;
  steps: ReadonlyArray<{ action: string; expect: string; watchFor?: string; chapter?: number }>;
  reason?: string;
};

export type FakeNote = {
  line: number;
  side: "additions" | "deletions";
  tone: "note" | "question" | "risk";
  text: string;
};

export type FakeChapter = {
  title: string;
  kind?: "core" | "supporting" | "data" | "config" | "tests" | "docs" | "generated";
  files: ReadonlyArray<string>;
  /** The chapter's level; the stand-in rates the others alike. */
  risk?: "low" | "medium" | "high";
  /** Sent as given, so a journey can send them JSON-encoded the way some agents' tool calls do. */
  body?: string | ReadonlyArray<string>;
  pseudocode?: string | { readonly before: string; readonly after: string };
};

const Prompt = Schema.fromJsonString(
  Schema.Struct({ prompt: Schema.String, context: Schema.NullOr(Schema.String) }),
);

/**
 * The stand-in Claude Code of scripts/fake-claude.ts, in a folder of its own: pass `file` to
 * `verify-app start --claude`. `hold` keeps its next guides, fixes and resolutions writing until
 * `release`, `holdAnswers` keeps its next answers after their first chunk until `releaseAnswers`,
 * `failing` makes them end with an error instead, `notes` gives its guides line notes,
 * `fileNotes` file notes, `manualCheck` their plan for checking the change by hand, `split`
 * gives each file of their guides a chapter of its own, `chapters` splits them into named
 * chapters (with a kind and level when given), `preflight` is the author's pre-flight their
 * guides send when the prompt asks for one, `flow` is their guides' before/after, `drafting` has
 * them draft first and wait after the overview and after the first chapter until `releaseDraft`
 * lets each step go, `edits` has its next fixes write files, and `plant` has its next fixes and
 * resolutions leave something behind (scripts/fake-claude.ts lists what).
 */
export const setUpFakeClaude = (name: string) => {
  const dir = NodePath.join(repoRoot, ".e2e", "fake", `${name}-claude`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "claude");
  const script = NodePath.join(repoRoot, "scripts", "fake-claude.ts");
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh\nFAKE_CLAUDE_DIR='${dir}' exec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o755 },
  );
  const flag = (
    name: "hold" | "hold-ask" | "fail" | "split" | "draft" | "draft-hold" | "chapter-hold",
    on: boolean,
  ) =>
    on
      ? NodeFS.writeFileSync(NodePath.join(dir, name), "")
      : NodeFS.rmSync(NodePath.join(dir, name), { force: true });
  return {
    file,
    hold: () => flag("hold", true),
    release: () => flag("hold", false),
    holdAnswers: () => flag("hold-ask", true),
    releaseAnswers: () => flag("hold-ask", false),
    failing: (on: boolean) => flag("fail", on),
    notes: (notes: Record<string, ReadonlyArray<FakeNote>>) =>
      NodeFS.writeFileSync(NodePath.join(dir, "notes"), JSON.stringify(notes)),
    fileNotes: (notes: Record<string, string>) =>
      NodeFS.writeFileSync(NodePath.join(dir, "file-notes"), JSON.stringify(notes)),
    manualCheck: (plan: FakeManualCheck) =>
      NodeFS.writeFileSync(NodePath.join(dir, "manual-check"), JSON.stringify(plan)),
    split: (on: boolean) => flag("split", on),
    flow: (flow: object) => NodeFS.writeFileSync(NodePath.join(dir, "flow"), JSON.stringify(flow)),
    /** Drafts the overview, then the first chapter, then submits; each waits while its step is held. */
    drafting: () => {
      flag("draft", true);
      flag("draft-hold", true);
      flag("chapter-hold", true);
    },
    /** Lets the draft go past the overview, then past the first chapter. */
    releaseDraft: (step: "overview" | "chapter") =>
      flag(step === "overview" ? "draft-hold" : "chapter-hold", false),
    chapters: (chapters: ReadonlyArray<FakeChapter>) =>
      NodeFS.writeFileSync(NodePath.join(dir, "chapters"), JSON.stringify(chapters)),
    /** Whole files, by path in the checkout, that the next fixes write. */
    edits: (files: Record<string, string>) =>
      NodeFS.writeFileSync(NodePath.join(dir, "edits"), JSON.stringify(files)),
    /** `null` goes back to `{}`, nothing to flag. */
    preflight: (preflight: object | null) =>
      preflight === null
        ? NodeFS.rmSync(NodePath.join(dir, "preflight"), { force: true })
        : NodeFS.writeFileSync(NodePath.join(dir, "preflight"), JSON.stringify(preflight)),
    /** `nested` takes the path for the repository; `null` stops planting it. */
    plant: (what: "nested" | "todo" | "linger", value: string | null) =>
      value === null
        ? NodeFS.rmSync(NodePath.join(dir, what), { force: true })
        : NodeFS.writeFileSync(NodePath.join(dir, what), value),
    /** The PID of the `sleep` the last `linger` turn left, or null. */
    lingering: () => {
      const file = NodePath.join(dir, "linger.pid");
      return NodeFS.existsSync(file) ? Number(NodeFS.readFileSync(file, "utf8")) : null;
    },
    /** Every prompt so far, oldest first, with the context file it named as the turn saw it (null when it named none). */
    prompts: () => {
      const file = NodePath.join(dir, "prompts.jsonl");
      if (!NodeFS.existsSync(file)) return [];
      return NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const turn = Schema.decodeUnknownSync(Prompt)(line);
          return {
            prompt: turn.prompt,
            context:
              turn.context === null
                ? null
                : NodeFS.readFileSync(NodePath.join(dir, turn.context), "utf8"),
          };
        });
    },
    /** Every turn so far: the config folder it ran with, its session, and whether it resumed or forked. */
    runs: () => {
      const file = NodePath.join(dir, "runs.log");
      if (!NodeFS.existsSync(file)) return [];
      return NodeFS.readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Schema.decodeUnknownSync(Run)(line));
    },
  };
};
