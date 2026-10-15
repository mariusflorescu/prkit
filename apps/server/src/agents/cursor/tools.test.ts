import { describe, expect, it } from "vite-plus/test";

import {
  describeToolCall,
  FIX_TOOL_SET,
  GUIDE_TOOL_SET,
  NEVER_TOOLS,
  toolSetFor,
} from "./tools.ts";

const call = (tool: string, fields: Partial<Parameters<typeof describeToolCall>[0]> = {}) =>
  describeToolCall(
    { type: "tool", callId: "c1", tool, path: null, pattern: null, mcp: null, ...fields },
    "prkit_1a2b3c4d",
    (path) => path.replace("/work/checkout/", ""),
  );

describe("Cursor's tools", () => {
  it("offers a guide reading tools only, and a fix edits too; never a shell or sub-agents", () => {
    expect(toolSetFor({ _tag: "read-only", tmpDir: "/tmp/t" })).toEqual(GUIDE_TOOL_SET);
    expect(
      toolSetFor({
        _tag: "write",
        scripts: { _tag: "allowed", names: ["test"] },
        tmpDir: "/tmp/t",
      }),
    ).toEqual(FIX_TOOL_SET);
    for (const never of NEVER_TOOLS) {
      expect(GUIDE_TOOL_SET).not.toContain(never);
      expect(FIX_TOOL_SET).not.toContain(never);
    }
    expect(GUIDE_TOOL_SET).not.toContain("edit");
  });

  it("names each call in plain words, and counts a whole-file read", () => {
    expect(call("read", { path: "/work/checkout/src/a.js" })).toEqual([
      {
        _tag: "tool",
        id: "c1",
        label: "Read src/a.js",
        detail: null,
        reads: [{ path: "/work/checkout/src/a.js", lines: { _tag: "all" } }],
      },
    ]);
    expect(call("grep", { pattern: "useState", path: "/work/checkout/src" })[0]).toMatchObject({
      label: "Searched for useState in src",
    });
    expect(call("glob", { pattern: "**/*.ts" })[0]).toMatchObject({
      label: "Listed files matching **/*.ts",
    });
    expect(call("edit", { path: "/work/checkout/src/a.js" })[0]).toMatchObject({
      label: "Edited src/a.js",
    });
    expect(call("updateTodos")).toEqual([]);
  });

  it("knows prkit's tools by the turn's server name, and keeps the quiet ones out of the log", () => {
    const prkit = (tool: string) => call("mcp", { mcp: { server: "prkit_1a2b3c4d", tool } });
    expect(prkit("report_progress")).toEqual([]);
    expect(prkit("submit_guide").map((event) => event._tag)).toEqual(["composing-guide", "tool"]);
    expect(prkit("finish_fixes")[0]).toMatchObject({ label: "Reported the fixes" });
    // The same tool name from another server is someone else's tool.
    expect(call("mcp", { mcp: { server: "prkit", tool: "submit_guide" } })).toEqual([
      { _tag: "tool", id: "c1", label: "Used submit_guide", detail: null, reads: [] },
    ]);
  });
});
