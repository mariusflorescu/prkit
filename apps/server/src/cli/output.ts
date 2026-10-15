import { stripVTControlCharacters } from "node:util";
import type * as Schema from "effect/Schema";

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
