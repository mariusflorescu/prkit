import type { DiffFile } from "@prkit/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hunkScopes } from "./scope";

const modified = (path: string, patch: string): DiffFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: { _tag: "text", patch },
});

const chainOf = (path: string, text: string, patch: string) =>
  hunkScopes(modified(path, patch), text).map((hunk) =>
    hunk.chain.map((opener) => [opener.line, opener.text.trim()]),
  );

describe("scope", () => {
  it("names the declarations above braces on lines of their own", () => {
    const text = [
      "namespace Shop",
      "{",
      "    public class Cart",
      "    {",
      "        public void Add(Item item)",
      "        {",
      "            if (item == null)",
      "            {",
      "                return;",
      "            }",
      "            items.Add(item);",
      "            total += item.Price;",
      "            count++;",
      "            Changed = true;",
      "        }",
      "    }",
      "}",
    ].join("\n");
    const patch = [
      "@@ -11,7 +11,7 @@ namespace Shop",
      "             items.Add(item);",
      "             total += item.Price;",
      "             count++;",
      "-            changed = true;",
      "+            Changed = true;",
      "         }",
      "     }",
      " }",
    ].join("\n");
    expect(chainOf("Cart.cs", text, patch)).toEqual([
      [
        [1, "namespace Shop"],
        [3, "public class Cart"],
        [5, "public void Add(Item item)"],
      ],
    ]);
  });

  it("names a function by the first line of a signature spread over several", () => {
    const text = [
      "export function render(",
      "  file: string,",
      "  options: { wrap: boolean },",
      "): string {",
      '  const lines = file.split("\\n");',
      "  const width = options.wrap ? 80 : Infinity;",
      "  const kept = lines.filter(Boolean);",
      '  const joined = kept.join("\\n");',
      "  return joined.slice(0, width - 1);",
      "}",
    ].join("\n");
    const patch = [
      "@@ -6,5 +6,5 @@ export function render(",
      "   const width = options.wrap ? 80 : Infinity;",
      "   const kept = lines.filter(Boolean);",
      '   const joined = kept.join("\\n");',
      "-  return joined.slice(0, width);",
      "+  return joined.slice(0, width - 1);",
      " }",
    ].join("\n");
    expect(chainOf("render.ts", text, patch)).toEqual([[[1, "export function render("]]]);
  });
});
