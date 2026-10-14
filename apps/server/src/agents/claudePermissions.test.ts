import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { TurnInput } from "./AgentProvider.ts";
import { claudePermissions } from "./claudePermissions.ts";
import { makeTestCheckout, removeTestCheckout } from "./testCheckout.ts";

// A guide turn's commands run in the sandbox too, but these answers to Claude's
// canUseTool are what keep its Read, Grep and Glob calls inside the checkout.
describe("claudePermissions for a guide", () => {
  let checkout: Effect.Success<ReturnType<typeof makeTestCheckout>>;
  beforeAll(async () => {
    checkout = await Effect.runPromise(makeTestCheckout());
  });
  afterAll(() => Effect.runPromise(removeTestCheckout(checkout.root)));

  const decide = (toolName: string, toolInput: Record<string, string | number | boolean>) => {
    const input: TurnInput = {
      turn: { id: "turn-1", ended: () => Effect.void },
      cwd: checkout.checkout,
      checkout: checkout.co,
      readableDirs: [checkout.diffs],
      instructions: "",
      prompt: "",
      resumeSessionId: null,
      model: null,
      options: [],
      mcp: { url: "http://127.0.0.1:1/mcp", bearerToken: "test" },
      env: {},
      access: { _tag: "read-only", tmpDir: "/nowhere" },
      tools: [],
    };
    return Effect.runPromise(claudePermissions(input, checkout.paths).decide(toolName, toolInput));
  };

  it.each([
    ["Bash", { command: "cat src/*.js" }],
    ["Read", { file_path: "src/a.js" }],
    ["Glob", { pattern: "*.js", path: "src" }],
  ])("lets %s read %j", async (toolName, toolInput) => {
    expect(await decide(toolName, toolInput)).toEqual({
      behavior: "allow",
      updatedInput: toolInput,
    });
  });

  it.each([
    ["Bash", { command: "cat *.md" }, "*.md"],
    ["Bash", { command: "echo ../*" }, "../*"],
    ["Read", { file_path: "notes.md" }, "notes.md"],
    ["Glob", { pattern: "{src,..}/*" }, "{src,..}/*"],
    ["Glob", { pattern: "../*", path: "src" }, "../*"],
  ])("refuses %s %j and names %s", async (toolName, toolInput, target) => {
    const answer = await decide(toolName, toolInput);
    expect(answer.behavior === "deny" ? answer.message : "allowed").toContain(
      `\`${target}\` can reach outside the pull request's checkout.`,
    );
  });

  it.each([
    ["Read", { file_path: 1 }],
    // Each tool's path is judged in its own field; one it doesn't take is refused.
    ["Grep", { pattern: "secret", path: "/etc", file_path: "src" }],
    ["Read", { file_path: "src/a.js", path: "/etc" }],
    ["Glob", { pattern: "*.js", file_path: "/etc" }],
  ])("refuses %s %j, whose input it can't check", async (toolName, toolInput) => {
    expect(await decide(toolName, toolInput)).toEqual({
      behavior: "deny",
      message: `prkit couldn't check the paths of this ${toolName} call.`,
    });
  });

  it.each([
    ["Grep", { pattern: "secret", path: "src", "-n": true, output_mode: "content" }],
    ["Grep", { pattern: "secret" }],
    ["Read", { file_path: "src/a.js", offset: 1, limit: 20 }],
  ])("lets %s read %j", async (toolName, toolInput) => {
    expect(await decide(toolName, toolInput)).toEqual({
      behavior: "allow",
      updatedInput: toolInput,
    });
  });

  it("judges Grep by its own path", async () => {
    const answer = await decide("Grep", { pattern: "secret", path: "linked" });
    expect(answer.behavior === "deny" ? answer.message : "allowed").toContain(
      "`linked` can reach outside the pull request's checkout.",
    );
  });
});
