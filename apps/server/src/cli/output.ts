import { stripVTControlCharacters } from "node:util";
import type * as Schema from "effect/Schema";
import { shellQuote } from "../outside/launcher.ts";

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
  const words = args.filter(
    (word, index) =>
      !oldFlags.includes(word) &&
      !oldFlags.some((old) => word.startsWith(`${old}=`)) &&
      !oldFlags.includes(args[index - 1] ?? ""),
  );
  const quote = (word: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : shellQuote(word));
  const command = ["prkit", ...words, flag, cursor].map(quote).join(" ");
  return `${fragment ? "Continue this response using the server's cursor. Join text fragments in offset order before decoding the complete JSON." : "Next page:"}\n${command}`;
};
