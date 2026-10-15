import { describe, expect, it } from "vite-plus/test";

import { pushesItself, startedByFor } from "./turnRules.ts";

// A fix an outside agent asked for waits for the owner's Push, however often it runs again.
describe("work an outside agent started", () => {
  it("never pushes by itself, even in a repository that pushes automatically", () => {
    expect(pushesItself(true, "Claude Code")).toBe(false);
    expect(pushesItself(true, null)).toBe(true);
    expect(pushesItself(false, null)).toBe(false);
  });

  it("still waits for Push after the owner clicks Retry in prkit", () => {
    const retried = startedByFor("Claude Code", null);
    expect(retried).toBe("Claude Code");
    expect(pushesItself(true, retried)).toBe(false);
  });

  it("counts as the client's when a client retries the owner's own turn", () => {
    expect(startedByFor(null, "Codex")).toBe("Codex");
    expect(startedByFor(null, null)).toBeNull();
  });
});
