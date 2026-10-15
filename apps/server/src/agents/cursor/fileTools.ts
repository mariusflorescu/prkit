// @effect-diagnostics-next-line nodeBuiltinImport:off -- the runner is a plain child process; prkit's file tools read with Node's own calls.
import * as NodeFs from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- matchesGlob has no counterpart in effect/Path.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type CheckoutPaths, MAX_LISTED } from "../checkoutPaths.ts";

/**
 * The file tools prkit gives Cursor in place of Cursor's own, which reach past the checkout.
 * They run in prkit's runner, never in Cursor's sandbox: every path lands where it really
 * points, symlinks resolved, and must stay in the checkout or an extra readable folder
 * (checkoutPaths.ts). `.git` is never read or listed, and nothing under `.cursor` or named
 * `sandbox.json` is written. A refusal is a plain sentence, never a path outside the checkout.
 */

/** The largest file read_file, grep and edit_file open. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** The most a read_file call returns, and the most write_file writes. */
export const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LINES = 2000;
export const MAX_RESULTS = 500;
const MAX_MATCHES = 200;
const MAX_LINE_CHARS = 300;

export interface ToolResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface FileTool {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, Schema.MutableJson>>;
  readonly readOnly: boolean;
  readonly run: (args: Readonly<Record<string, Schema.Json>>) => Promise<ToolResult>;
}

const ok = (text: string): ToolResult => ({ ok: true, text });
const refused = (text: string): ToolResult => ({ ok: false, text });

const OUTSIDE = refused(
  "Refused: that path is outside the pull request's checkout, inside .git, or behind a link that leads out. Use a path inside the working directory.",
);
const NOT_WRITABLE = refused(
  "Refused: only files in the pull request's checkout can change, never through a link, never .git, .cursor or a sandbox.json.",
);

const ReadArgs = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
const ListArgs = Schema.Struct({ path: Schema.optionalKey(Schema.String) });
const GlobArgs = Schema.Struct({ pattern: Schema.String, path: Schema.optionalKey(Schema.String) });
const GrepArgs = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
  glob: Schema.optionalKey(Schema.String),
  case_insensitive: Schema.optionalKey(Schema.Boolean),
});
const WriteArgs = Schema.Struct({ path: Schema.String, content: Schema.String });
const EditArgs = Schema.Struct({
  path: Schema.String,
  old_string: Schema.String,
  new_string: Schema.String,
  replace_all: Schema.optionalKey(Schema.Boolean),
});

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);
const isGitName = (name: string) => name.toLowerCase() === ".git";
const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

/** A pattern that starts at a root or climbs out with `..`. */
const climbs = (pattern: string) =>
  NodePath.isAbsolute(pattern) || pattern.startsWith("~") || pattern.split(/[\\/]/).includes("..");

/**
 * prkit's file tools for one turn in `checkout`: reading, listing and searching for every turn,
 * and writing and editing for a fix.
 */
export const makeFileTools = (where: {
  /** The checkout's real path, links resolved. */
  readonly checkout: string;
  readonly paths: CheckoutPaths;
  readonly writes: boolean;
}) => {
  const { checkout, paths } = where;
  const absolute = (target: string) => NodePath.resolve(checkout, target);
  const shown = (target: string) => {
    const relative = NodePath.relative(checkout, target);
    return relative === "" ? "." : relative.startsWith("..") ? target : relative;
  };
  const canRead = (target: string) => Effect.runPromise(paths.reads([target]));
  const canWrite = (target: string) => Effect.runPromise(paths.writable([target]));

  /** The real path of a target that may not exist yet: its real folder, then the rest. */
  const realTarget = async (target: string): Promise<string> => {
    try {
      return await NodeFs.realpath(target);
    } catch {
      const parent = NodePath.dirname(target);
      return parent === target
        ? target
        : NodePath.join(await realTarget(parent), NodePath.basename(target));
    }
  };

  /** Where a write lands, or null when it may not: outside, through a link, `.git`, `.cursor`, `sandbox.json`. */
  const writeTarget = async (given: string) => {
    const target = absolute(given);
    if (!(await canWrite(target))) return null;
    const real = await realTarget(target);
    const parts = NodePath.relative(checkout, real).split(NodePath.sep);
    if (parts[0] === "..") return null;
    if (parts.some((part) => part.toLowerCase() === ".cursor" || isGitName(part))) return null;
    if (parts.at(-1)?.toLowerCase() === "sandbox.json") return null;
    return real;
  };

  /** A readable file's real path and bytes, or the refusal to return instead. */
  const openFile = async (given: string): Promise<ToolResult | { real: string; bytes: Buffer }> => {
    const target = absolute(given);
    if (!(await canRead(target))) return OUTSIDE;
    const real = await NodeFs.realpath(target);
    const info = await NodeFs.stat(real);
    if (info.isDirectory()) return refused("That's a folder. Use list_dir.");
    if (!info.isFile()) return refused("That isn't a regular file.");
    if (info.size > MAX_FILE_BYTES) return refused("That file is too large for prkit to open.");
    return { real, bytes: await NodeFs.readFile(real) };
  };

  /**
   * Every entry under `dir`, folders before their contents, never `.git` and never into a link.
   * Stops after MAX_LISTED entries.
   */
  async function* walk(
    dir: string,
    budget: { left: number },
  ): AsyncGenerator<{
    readonly at: string;
    readonly kind: "file" | "folder" | "link";
  }> {
    const entries = await NodeFs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isGitName(entry.name)) continue;
      if (--budget.left < 0) return;
      const at = NodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) yield { at, kind: "link" };
      else if (entry.isDirectory()) {
        yield { at, kind: "folder" };
        yield* walk(at, budget);
      } else if (entry.isFile()) yield { at, kind: "file" };
    }
  }

  /** The folder a listing or search starts in, or null when it may not be read. */
  const folder = async (given: string | undefined) => {
    const target = absolute(given ?? ".");
    if (!(await canRead(target))) return null;
    return NodeFs.realpath(target);
  };

  const guarded =
    <A>(schema: Schema.Codec<A, A>, run: (args: A) => Promise<ToolResult>): FileTool["run"] =>
    async (args) => {
      const decoded = Schema.decodeUnknownOption(schema)(args);
      if (Option.isNone(decoded)) return refused("The arguments didn't match the tool's schema.");
      try {
        return await run(decoded.value);
      } catch {
        return refused("prkit couldn't do that: the file or folder is missing or unreadable.");
      }
    };

  const read: FileTool = {
    description:
      "Read a text file in the pull request's checkout. `path` is relative to the working directory. Returns up to 2000 lines from `offset` (1-based line, default 1); pass `limit` for fewer.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
    readOnly: true,
    run: guarded(ReadArgs, async ({ path, offset, limit }) => {
      const file = await openFile(path);
      if ("ok" in file) return file;
      if (isBinary(file.bytes)) return refused("That's a binary file; prkit reads text only.");
      const lines = file.bytes.toString("utf8").split("\n");
      const start = Math.max(1, Math.floor(offset ?? 1));
      const count = Math.min(MAX_LINES, Math.max(1, Math.floor(limit ?? MAX_LINES)));
      let text = lines.slice(start - 1, start - 1 + count).join("\n");
      let end = Math.min(lines.length, start - 1 + count);
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
        text = Buffer.from(text).subarray(0, MAX_TEXT_BYTES).toString("utf8");
        end = start - 1 + text.split("\n").length;
      }
      return ok(
        end < lines.length || start > 1
          ? `${text}\n(lines ${start}-${end} of ${lines.length}; pass offset to read more)`
          : text,
      );
    }),
  };

  const listDir: FileTool = {
    description:
      "List a folder in the pull request's checkout. `path` is relative to the working directory, the working directory itself by default. Folders end in /, links in @.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [] },
    readOnly: true,
    run: guarded(ListArgs, async ({ path }) => {
      const dir = await folder(path);
      if (dir === null) return OUTSIDE;
      const entries = await NodeFs.readdir(dir, { withFileTypes: true });
      const names = entries
        .filter((entry) => !isGitName(entry.name))
        .map((entry) =>
          entry.isSymbolicLink()
            ? `${entry.name}@`
            : entry.isDirectory()
              ? `${entry.name}/`
              : entry.name,
        )
        .sort();
      if (names.length === 0) return ok("(empty folder)");
      const more =
        names.length > MAX_RESULTS ? `\n(${names.length - MAX_RESULTS} more not shown)` : "";
      return ok(`${names.slice(0, MAX_RESULTS).join("\n")}${more}`);
    }),
  };

  const glob: FileTool = {
    description:
      "Find files by name in the pull request's checkout: `pattern` is a glob such as `src/**/*.ts`, matched from `path` (the working directory by default). Never follows links.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
    readOnly: true,
    run: guarded(GlobArgs, async ({ pattern, path }) => {
      if (climbs(pattern)) return OUTSIDE;
      const dir = await folder(path);
      if (dir === null) return OUTSIDE;
      const found: Array<string> = [];
      const budget = { left: MAX_LISTED };
      for await (const entry of walk(dir, budget)) {
        if (entry.kind === "folder") continue;
        if (!NodePath.matchesGlob(NodePath.relative(dir, entry.at), pattern)) continue;
        found.push(shown(entry.at));
        if (found.length >= MAX_RESULTS) break;
      }
      if (found.length === 0) return ok("No files match.");
      const cut = found.length >= MAX_RESULTS || budget.left < 0;
      return ok(
        `${found.join("\n")}${cut ? "\n(more matches not shown; narrow the pattern)" : ""}`,
      );
    }),
  };

  const grep: FileTool = {
    description:
      "Search text files in the pull request's checkout for a JavaScript regular expression. `path` is a file or folder (the working directory by default) and `glob` narrows the files. Returns path:line: text, at most 200 lines.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
        case_insensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
    readOnly: true,
    run: guarded(GrepArgs, async (args) => {
      let regex: RegExp;
      try {
        regex = new RegExp(args.pattern, args.case_insensitive === true ? "i" : "");
      } catch {
        return refused("That isn't a valid regular expression.");
      }
      if (args.glob !== undefined && climbs(args.glob)) return OUTSIDE;
      const start = absolute(args.path ?? ".");
      if (!(await canRead(start))) return OUTSIDE;
      const real = await NodeFs.realpath(start);
      const files: Array<string> = [];
      const budget = { left: MAX_LISTED };
      if ((await NodeFs.stat(real)).isFile()) files.push(real);
      else
        for await (const entry of walk(real, budget))
          if (
            entry.kind === "file" &&
            (args.glob === undefined ||
              NodePath.matchesGlob(NodePath.relative(real, entry.at), args.glob))
          )
            files.push(entry.at);
      const matches: Array<string> = [];
      for (const file of files) {
        const info = await NodeFs.stat(file);
        if (info.size > MAX_FILE_BYTES) continue;
        const bytes = await NodeFs.readFile(file);
        if (isBinary(bytes)) continue;
        for (const [index, line] of bytes.toString("utf8").split("\n").entries()) {
          if (!regex.test(line)) continue;
          matches.push(`${shown(file)}:${index + 1}: ${clip(line)}`);
          if (matches.length >= MAX_MATCHES)
            return ok(`${matches.join("\n")}\n(more matches not shown; narrow the search)`);
        }
      }
      return ok(matches.length === 0 ? "No matches." : matches.join("\n"));
    }),
  };

  const write: FileTool = {
    description:
      "Create or replace a text file in the pull request's checkout with `content`. `path` is relative to the working directory. Prefer edit_file to change part of a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    readOnly: false,
    run: guarded(WriteArgs, async ({ path, content }) => {
      if (Buffer.byteLength(content) > MAX_TEXT_BYTES)
        return refused("That content is too large for one write.");
      const target = await writeTarget(path);
      if (target === null) return NOT_WRITABLE;
      await NodeFs.mkdir(NodePath.dirname(target), { recursive: true });
      // Checked again once its folders exist: a folder made on the way must not be a link out.
      if ((await writeTarget(target)) !== target) return NOT_WRITABLE;
      await NodeFs.writeFile(target, content);
      return ok(`Wrote ${shown(target)}.`);
    }),
  };

  const edit: FileTool = {
    description:
      "Change a text file in the pull request's checkout: replace `old_string`, copied exactly from the file, with `new_string`. `old_string` must appear once, unless `replace_all` is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    readOnly: false,
    run: guarded(EditArgs, async (args) => {
      const target = await writeTarget(args.path);
      if (target === null) return NOT_WRITABLE;
      const file = await openFile(target);
      if ("ok" in file) return file;
      if (isBinary(file.bytes)) return refused("That's a binary file; prkit edits text only.");
      const text = file.bytes.toString("utf8");
      if (args.old_string === "") return refused("old_string is empty. Use write_file instead.");
      const count = text.split(args.old_string).length - 1;
      if (count === 0)
        return refused("old_string isn't in the file. Read it again and copy it exactly.");
      if (count > 1 && args.replace_all !== true)
        return refused(
          `old_string appears ${count} times. Add more surrounding text, or set replace_all.`,
        );
      const next = text.split(args.old_string).join(args.new_string);
      if (Buffer.byteLength(next) > MAX_FILE_BYTES)
        return refused("The edited file would be too large.");
      await NodeFs.writeFile(target, next);
      return ok(`Edited ${shown(target)}.`);
    }),
  };

  const tools: Record<string, FileTool> = {
    read_file: read,
    list_dir: listDir,
    glob,
    grep,
  };
  if (where.writes) {
    tools["write_file"] = write;
    tools["edit_file"] = edit;
  }
  return tools;
};

/** prkit's file tools for a guide; a fix adds write_file and edit_file. */
export const READ_FILE_TOOLS = ["read_file", "list_dir", "glob", "grep"] as const;
export const WRITE_FILE_TOOLS = ["write_file", "edit_file"] as const;
