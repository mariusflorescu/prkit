import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { repoRoot } from "../scripts/verify-run.ts";

const Run = Schema.fromJsonString(
  Schema.Struct({
    configDir: Schema.NullOr(Schema.String),
    session: Schema.String,
    resumed: Schema.Boolean,
  }),
);

export type FakeNote = {
  line: number;
  side: "additions" | "deletions";
  tone: "note" | "question" | "risk";
  text: string;
};

const Prompt = Schema.fromJsonString(
  Schema.Struct({ prompt: Schema.String, context: Schema.NullOr(Schema.String) }),
);

/**
 * The stand-in Claude Code of scripts/fake-claude.ts, in a folder of its own: pass `file` to
 * `verify-app start --claude`. `hold` keeps its next turns writing until `release`,
 * `failing` makes them end with an error instead of a guide, `notes` gives its guides line
 * notes, `split` gives each file of their guides a chapter of its own, and `plant` has its
 * next fixes and resolutions leave something behind (scripts/fake-claude.ts lists what).
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
  const flag = (name: "hold" | "fail" | "split", on: boolean) =>
    on
      ? NodeFS.writeFileSync(NodePath.join(dir, name), "")
      : NodeFS.rmSync(NodePath.join(dir, name), { force: true });
  return {
    file,
    hold: () => flag("hold", true),
    release: () => flag("hold", false),
    failing: (on: boolean) => flag("fail", on),
    notes: (notes: Record<string, ReadonlyArray<FakeNote>>) =>
      NodeFS.writeFileSync(NodePath.join(dir, "notes"), JSON.stringify(notes)),
    split: (on: boolean) => flag("split", on),
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
    /** Every turn so far: the config folder it ran with, its session, and whether it resumed. */
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
