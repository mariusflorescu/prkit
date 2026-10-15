import { expect, it } from "vite-plus/test";
import { commandMap, mappings, toolkit } from "./commands.ts";

it("gives every outside tool exactly one CLI command and no command without a tool", () => {
  expect(Object.keys(commandMap).sort()).toEqual(Object.keys(toolkit.tools).sort());
  expect(new Set(mappings.map(([, mapping]) => mapping.path.join(" "))).size).toBe(mappings.length);
});
