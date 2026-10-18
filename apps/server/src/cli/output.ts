import { stripVTControlCharacters } from "node:util";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { shellQuote } from "../outside/launcher.ts";
import {
  GenerateLocalGuideResult,
  LocalGuideResult,
  LocalGuideStatus,
  LocalWaitResult,
} from "../outside/schemas.ts";

const scalar = (value: Schema.Json) => value === null || typeof value !== "object";
const plain = (value: Schema.Json) =>
  stripVTControlCharacters(String(value ?? "-")).replace(/\p{Cc}/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );

export const humanOutput = (value: Schema.Json, depth = 0): string => {
  if (scalar(value)) return plain(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "None.";
    const rows = value.filter(
      (row): row is Record<string, Schema.Json> =>
        row !== null && typeof row === "object" && !Array.isArray(row),
    );
    if (rows.length === value.length) {
      const columns = [
        ...new Set(
          rows.flatMap((row) =>
            Object.entries(row)
              .filter(([, cell]) => scalar(cell))
              .map(([key]) => key),
          ),
        ),
      ];
      if (columns.length > 0) {
        const cells = rows.map((row) =>
          columns.map((key) => plain(row[key] ?? null).replace(/\r?\n/g, " ")),
        );
        const widths = columns.map((column, index) =>
          Math.min(64, Math.max(column.length, ...cells.map((row) => row[index]?.length ?? 0))),
        );
        const line = (row: string[]) =>
          row
            .map((cell, index) => cell.slice(0, widths[index]).padEnd(widths[index] ?? 0))
            .join("  ")
            .trimEnd();
        const table = [line(columns), ...cells.map(line)].join("\n");
        const details = rows
          .map((row) =>
            Object.entries(row)
              .filter(
                ([, cell]) =>
                  !scalar(cell) ||
                  (typeof cell === "string" && (cell.length > 64 || cell.includes("\n"))),
              )
              .map(([key, cell]) => `${key}:\n${humanOutput(cell, depth + 1)}`)
              .join("\n"),
          )
          .filter(Boolean);
        return [table, ...details].join("\n\n");
      }
    }
    return value.map((entry) => humanOutput(entry, depth + 1)).join("\n\n");
  }
  return Object.entries(value)
    .map(([key, entry]) =>
      scalar(entry) ? `${key}: ${plain(entry)}` : `${key}:\n${humanOutput(entry, depth + 1)}`,
    )
    .join(depth === 0 ? "\n\n" : "\n");
};

export const continuationOutput = (value: Schema.Json, args: readonly string[]) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const fragment = "_tag" in value && value._tag === "response-fragment";
  const cursor = fragment
    ? "nextResponseCursor" in value
      ? value.nextResponseCursor
      : null
    : "nextCursor" in value
      ? value.nextCursor
      : null;
  if (typeof cursor !== "string")
    return fragment
      ? "Final response fragment. Join the text fragments in offset order and decode the complete JSON before reading its page cursor."
      : "";
  const flag = fragment ? "--response-cursor" : "--cursor";
  const oldFlags = fragment ? [flag] : [flag, "--response-cursor"];
  const terminator = args.indexOf("--");
  const options = terminator < 0 ? args : args.slice(0, terminator);
  const positionals = terminator < 0 ? [] : args.slice(terminator);
  const words = options.filter(
    (word, index) =>
      !oldFlags.includes(word) &&
      !oldFlags.some((old) => word.startsWith(`${old}=`)) &&
      !oldFlags.includes(options[index - 1] ?? ""),
  );
  const quote = (word: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : shellQuote(word));
  const command = ["prkit", ...words, flag, cursor, ...positionals].map(quote).join(" ");
  return `${fragment ? "Continue this response using the server's cursor. Join text fragments in offset order before decoding the complete JSON." : "Next page:"}\n${command}`;
};

const titleOf = (status: LocalGuideStatus) =>
  `${status.name} · ${status.branch ?? "detached HEAD"}`;

/** The run's left-out files as one calm line: counts by why, with the list behind --json. */
const leftOutLine = (status: LocalGuideStatus) => {
  const files = status.run?.leftOut ?? [];
  if (files.length === 0) return null;
  const count = (reason: string) => files.filter((file) => file.reason === reason).length;
  const parts = [
    [count("too-large"), "over 50 MB"],
    [count("filtered"), "through a git filter such as Git LFS"],
    [count("nested-repository"), "repositories of their own"],
  ] as const;
  return `${files.length} left out of the snapshot (${parts
    .flatMap(([number, why]) => (number === 0 ? [] : [`${number} ${why}`]))
    .join(", ")}). --json lists them.`;
};

const stateLine = (status: LocalGuideStatus) => {
  const title = titleOf(status);
  switch (status.state) {
    case "preparing":
      return `${title}: getting ready to write the guide.`;
    case "writing":
      return `${title}: writing the guide${status.progress === null ? "" : `, ${status.progress.filesRead} of ${status.progress.files} files read`}.`;
    case "ready":
      return `${title}: guide revision ${status.latestRevision ?? 1} is ready${status.run === null ? "" : `, against ${status.run.baseRef}`}.`;
    case "failed":
      return `${title}: the guide failed. ${status.message ?? ""}`.trimEnd();
    case "stopped":
      return `${title}: stopped.`;
  }
};

/**
 * Plain output for `prkit local`: what happened in a line or two and the command that
 * follows it. `named` says the command named its review (a key, a path or a branch), so the
 * follow-up names it by key too. Null for a result this doesn't describe.
 */
export const localOutput = (name: string, value: Schema.Json, named: boolean) => {
  const follow = (command: "wait" | "read", key: string) =>
    `prkit local ${command}${named ? ` --key ${key}` : ""}`;
  const lines = (...parts: ReadonlyArray<string | null>) =>
    parts.filter((part) => part !== null).join("\n");
  if (name === "generate_local_guide")
    return Option.match(Schema.decodeUnknownOption(GenerateLocalGuideResult)(value), {
      onNone: () => null,
      onSome: (result) =>
        lines(
          plain(result.message),
          result.outcome === "unchanged"
            ? `Read it: ${follow("read", result.status.key)}`
            : `Follow it: ${follow("wait", result.status.key)}, then ${follow("read", result.status.key)}`,
        ),
    });
  if (name === "read_local_guide")
    return Option.match(Schema.decodeUnknownOption(LocalGuideResult)(value), {
      onNone: () => null,
      onSome: ({ status, guide }) =>
        lines(
          plain(stateLine(status)),
          leftOutLine(status),
          guide === null
            ? null
            : plain(
                `${guide.content.summary[0] ?? ""}${guide.content.chapters.length === 0 ? "" : ` (${guide.content.chapters.length} chapters)`}`.trim(),
              ),
          status.state === "preparing" || status.state === "writing"
            ? `Follow it: ${follow("wait", status.key)}`
            : guide === null
              ? null
              : "Print the whole guide with --json.",
        ),
    });
  if (name === "wait_for_local_guide")
    return Option.match(Schema.decodeUnknownOption(LocalWaitResult)(value), {
      onNone: () => null,
      onSome: ({ finished, status }) =>
        lines(
          plain(stateLine(status)),
          finished
            ? status.state === "ready"
              ? `Read it: ${follow("read", status.key)}`
              : null
            : `Still running. Wait again: ${follow("wait", status.key)}`,
        ),
    });
  if (name === "stop_local_guide")
    return Option.match(Schema.decodeUnknownOption(LocalGuideStatus)(value), {
      onNone: () => null,
      onSome: (status) =>
        plain(
          status.state === "stopped"
            ? `Stopped the guide of ${titleOf(status)}. Its revisions stay readable.`
            : `Nothing is being written for ${titleOf(status)}.`,
        ),
    });
  return null;
};
