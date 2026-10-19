import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { repoRoot } from "../scripts/verify-run.ts";

const Run = Schema.fromJsonString(
  Schema.Struct({
    codexHome: Schema.NullOr(Schema.String),
    cwd: Schema.String,
    thread: Schema.String,
    start: Schema.Literals(["new", "resume", "fork"]),
    model: Schema.NullOr(Schema.String),
    effort: Schema.NullOr(Schema.String),
    serviceTier: Schema.NullOr(Schema.String),
  }),
);

export type FakeCodexModel = {
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReadonlyArray<{ reasoningEffort: string }>;
};

/**
 * The stand-in Codex of scripts/fake-codex.ts, in a folder of its own: pass `file` to
 * `verify-app start --codex`. `models` replaces the models its login offers (`null` goes back to
 * the built-in list, shaped like Codex 0.163's), `pageSize` pages that list, and `runs` is every
 * guide turn so far.
 */
export const setUpFakeCodex = (name: string) => {
  const dir = NodePath.join(repoRoot, ".e2e", "fake", `${name}-codex`);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "codex");
  const script = NodePath.join(repoRoot, "scripts", "fake-codex.ts");
  NodeFS.writeFileSync(
    file,
    `#!/bin/sh\nFAKE_CODEX_DIR='${dir}' exec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o755 },
  );
  return {
    file,
    models: (list: ReadonlyArray<FakeCodexModel> | null) =>
      list === null
        ? NodeFS.rmSync(NodePath.join(dir, "models.json"), { force: true })
        : NodeFS.writeFileSync(NodePath.join(dir, "models.json"), JSON.stringify(list)),
    /** Pages `model/list` that many models at a time, as Codex does; `null` sends the whole list at once. */
    pageSize: (size: number | null) =>
      size === null
        ? NodeFS.rmSync(NodePath.join(dir, "page-size"), { force: true })
        : NodeFS.writeFileSync(NodePath.join(dir, "page-size"), String(size)),
    /** Every turn so far: the Codex home and directory it ran in, its thread, how the thread opened, and the model, effort and service tier the turn carried (null when none). */
    runs: () => {
      const log = NodePath.join(dir, "runs.log");
      if (!NodeFS.existsSync(log)) return [];
      return NodeFS.readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Schema.decodeUnknownSync(Run)(line));
    },
  };
};
