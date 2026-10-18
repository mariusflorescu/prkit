import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** One generated module: a class whose methods are long enough for a one-line hunk to float. */
const moduleText = (index: number, methods: number) => {
  const lines = [
    `// Generated module ${index}: a store of records with checks.`,
    `export class Store${index} {`,
  ];
  lines.push(
    "  constructor() {",
    "    this.records = new Map();",
    "    this.listeners = [];",
    "  }",
    "",
  );
  for (let method = 0; method < methods; method++) {
    lines.push(`  update${method}(id, patch) {`);
    lines.push("    const record = this.records.get(id);", "    if (!record) return null;");
    lines.push(
      "    for (const listener of this.listeners) {",
      "      if (listener.paused) continue;",
    );
    for (let step = 0; step < 14; step++)
      lines.push(
        `      listener.notify("update${method}", { id, step: ${step}, size: this.records.size });`,
      );
    lines.push(
      "    }",
      `    const next = { ...record, ...patch, version: record.version + ${method + 1} };`,
    );
    lines.push("    this.records.set(id, next);", "    return next;", "  }", "");
  }
  lines.push("}", "");
  return lines.join("\n");
};

/** A free function that a later module takes over, so the diff holds moves between files. */
const helperText = (index: number) =>
  [
    `export function summarize${index}(records) {`,
    "  let total = 0;",
    "  let newest = null;",
    "  for (const record of records.values()) {",
    "    total += record.version;",
    "    if (newest === null || record.updatedAt > newest.updatedAt) newest = record;",
    "  }",
    `  return { module: ${index}, total, newest: newest?.id ?? null, count: records.size };`,
    "}",
    "",
  ].join("\n");

const patchOf = (dir: string, before: string, after: string) => {
  NodeFS.writeFileSync(NodePath.join(dir, "a"), before);
  NodeFS.writeFileSync(NodePath.join(dir, "b"), after);
  const result = NodeChildProcess.spawnSync("git", ["diff", "--no-index", "--no-color", "a", "b"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const text = result.stdout;
  const first = text.indexOf("\n@@");
  return first < 0 ? "" : text.slice(first + 1).replace(/\n$/, "");
};

const count = (patch: string, marker: "+" | "-") =>
  patch
    .split("\n")
    .filter((line) => line.startsWith(marker) && !line.startsWith(`${marker}${marker}${marker}`))
    .length;

/**
 * A pull request of `files` modified modules, about `files * methods * 24` lines each side,
 * served the way GitHub's files API serves patches: every module gets one-line edits deep
 * inside a few methods, and every other module hands a helper function to the next one.
 */
export const largeDiff = (files: number, methods: number) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-large-diff-"));
  try {
    const served: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string;
    }> = [];
    const texts: Record<string, string> = {};
    for (let index = 0; index < files; index++) {
      const path = `src/stores/store${String(index).padStart(3, "0")}.js`;
      const base = moduleText(index, methods);
      const gives = index % 2 === 0 && index + 1 < files;
      const takes = index % 2 === 1;
      const before = `${base}${gives ? `\n${helperText(index)}` : ""}`;
      let after = base;
      for (let method = 1; method < methods; method += 3)
        after = after.replace(
          `listener.notify("update${method}", { id, step: 9,`,
          `listener.notify("update${method}", { id, step: 9, at: Date.now(),`,
        );
      if (takes) after = `${helperText(index - 1)}\n${after}`;
      const patch = patchOf(dir, before, after);
      served.push({
        filename: path,
        status: "modified",
        additions: count(patch, "+"),
        deletions: count(patch, "-"),
        patch,
      });
      texts[path] = after;
    }
    return { files: served, texts };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};
