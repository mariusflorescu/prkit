import { describe, expect, it } from "vite-plus/test";

import { ALLOWED_TOOLS, DENIED_TOOLS, describeToolCall, fileToolsFor } from "./tools.ts";

const call = (tool: string, fields: Partial<Parameters<typeof describeToolCall>[0]> = {}) =>
  describeToolCall(
    { type: "tool", callId: "c1", tool, name: tool, path: null, pattern: null, ...fields },
    (path) => path.replace("/work/checkout/", ""),
  );

describe("Cursor's tools", () => {
  it("keeps none of Cursor's own tools, only the two that carry prkit's", () => {
    expect(ALLOWED_TOOLS).toEqual(["mcp_tool_call", "get_mcp_tools_tool_call"]);
    for (const tool of ALLOWED_TOOLS) expect(DENIED_TOOLS).not.toContain(tool);
    expect(DENIED_TOOLS).toEqual(
      expect.arrayContaining([
        "read_tool_call",
        "edit_tool_call",
        "delete_tool_call",
        "ls_tool_call",
        "grep_tool_call",
        "glob_tool_call",
        "shell_tool_call",
        "write_shell_stdin_tool_call",
        "task_tool_call",
        "web_fetch_tool_call",
        "web_search_tool_call",
        "fetch_tool_call",
        "read_mcp_resource_tool_call",
        "update_todos_tool_call",
      ]),
    );
  });

  it("gives a guide prkit's reading tools, and a fix writing too, never a command", () => {
    expect(fileToolsFor({ _tag: "read-only", tmpDir: "/tmp/t" })).toEqual([
      "read_file",
      "list_dir",
      "glob",
      "grep",
    ]);
    expect(
      fileToolsFor({
        _tag: "write",
        scripts: { _tag: "allowed", names: ["test"] },
        tmpDir: "/tmp/t",
      }),
    ).toEqual(["read_file", "list_dir", "glob", "grep", "write_file", "edit_file"]);
  });

  it("names each call in plain words, and counts a whole-file read", () => {
    expect(call("read_file", { path: "/work/checkout/src/a.js" })).toEqual([
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
    expect(call("edit_file", { path: "/work/checkout/src/a.js" })[0]).toMatchObject({
      label: "Edited src/a.js",
    });
  });

  it("labels prkit's tools, and keeps the quiet ones out of the log", () => {
    const prkit = (name: string) => call("prkit", { name });
    expect(prkit("report_progress")).toEqual([]);
    expect(prkit("submit_guide").map((event) => event._tag)).toEqual(["composing-guide", "tool"]);
    expect(prkit("finish_fixes")[0]).toMatchObject({ label: "Reported the fixes" });
    expect(call("other", { name: "shell" })).toEqual([
      { _tag: "tool", id: "c1", label: "Used shell", detail: null, reads: [] },
    ]);
  });
});
