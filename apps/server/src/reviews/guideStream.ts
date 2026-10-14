import { DraftGuide } from "@prkit/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeDraft = Schema.decodeUnknownOption(Schema.fromJsonString(DraftGuide));
const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));
/** Top-level fields a draft shows. `chapters` arrives one chapter at a time instead. */
const DRAFT_FIELDS: ReadonlySet<string> = new Set([
  "summary",
  "background",
  "steps",
  "flow",
  "focus",
]);

/**
 * Reads a `submit_guide` call's input while the agent writes it, as fragments of
 * JSON text, and hands back each piece of the guide the moment it is complete: a
 * top-level field, or one chapter. A piece is parsed only once it is closed, so a
 * fragment that ends mid-string is never read; a piece that doesn't decode is
 * dropped and the caller keeps what it had.
 */
export const makeGuideStream = () => {
  let text = "";
  let at = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  /** The top-level key whose value is being read, null between fields. */
  let key: string | null = null;
  let valueStart = -1;
  let chapterStart = -1;
  let chaptersOpen = false;

  const field = (raw: string, pieces: Array<DraftGuide>) => {
    const name = key ?? "";
    key = null;
    valueStart = -1;
    if (name === "chapters") chaptersOpen = false;
    if (!DRAFT_FIELDS.has(name)) return;
    const piece = decodeDraft(`{${JSON.stringify(name)}:${raw}}`);
    if (Option.isSome(piece)) pieces.push(piece.value);
  };

  /** Adds a fragment; returns the pieces it completed, in order. */
  const feed = (fragment: string): ReadonlyArray<DraftGuide> => {
    text += fragment;
    const pieces: Array<DraftGuide> = [];
    for (; at < text.length; at++) {
      const char = text.charAt(at);
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          inString = false;
          if (depth !== 1) continue;
          if (valueStart === stringStart) field(text.slice(valueStart, at + 1), pieces);
          else if (key === null)
            key = Option.getOrElse(decodeKey(text.slice(stringStart, at + 1)), () => "");
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        stringStart = at;
        if (depth === 1 && key !== null && valueStart === -1) valueStart = at;
      } else if (char === "{" || char === "[") {
        if (depth === 1 && key !== null && valueStart === -1) {
          valueStart = at;
          if (key === "chapters" && char === "[") chaptersOpen = true;
        }
        if (depth === 2 && chaptersOpen && char === "{") chapterStart = at;
        depth++;
      } else if (char === "}" || char === "]") {
        if (depth === 1 && valueStart !== -1) field(text.slice(valueStart, at).trim(), pieces);
        depth--;
        if (depth === 2 && chaptersOpen && char === "}" && chapterStart !== -1) {
          const piece = decodeDraft(`{"chapters":[${text.slice(chapterStart, at + 1)}]}`);
          if (Option.isSome(piece)) pieces.push(piece.value);
          chapterStart = -1;
        }
        if (depth === 1 && valueStart !== -1) field(text.slice(valueStart, at + 1), pieces);
      } else if (depth === 1 && char === ",") {
        if (valueStart !== -1) field(text.slice(valueStart, at).trim(), pieces);
      } else if (
        depth === 1 &&
        key !== null &&
        valueStart === -1 &&
        char !== ":" &&
        char.trim() !== ""
      )
        valueStart = at;
    }
    return pieces;
  };

  return {
    feed,
    /** The `chapters` list has started and not closed: more chapters may still come. */
    chaptersOpen: () => chaptersOpen,
  };
};
