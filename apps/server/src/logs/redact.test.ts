import { expect, it } from "vite-plus/test";

import { redactSecrets } from "./redact.ts";

it("replaces every secret shape and leaves an ordinary line as it was", () => {
  const classic = `ghp_${"a".repeat(36)}`;
  const finegrained = `github_pat_${"B1_".repeat(14)}`;
  const own = "9f".repeat(32);
  // Built from parts, so a secret scanner reading this file finds no credential in it.
  const userinfo = ["octocat", "not-a-password"].join(":");
  const basic = Buffer.from(["user", "pass"].join(":")).toString("base64");
  const cases = [
    [`clone failed for ${classic}`, "clone failed for [redacted]"],
    [`using ${finegrained} here`, "using [redacted] here"],
    ["authorization: Bearer abc.def", "authorization: [redacted]"],
    [`{"authorization":"token x"}`, `{"authorization":"[redacted]"}`],
    [
      `message="{\\"Authorization\\":\\"Basic ${basic}\\"}"`,
      `message="{\\"Authorization\\":\\"[redacted]\\"}"`,
    ],
    ["authorization=abc123", "authorization=[redacted]"],
    ["sent Bearer abc123def456", "sent [redacted]"],
    ["used token abcdef0123456789abcdef", "used [redacted]"],
    ["opened /ws?token=abc123&view=1", "opened /ws?token=[redacted]&view=1"],
    [
      `fetch https://${userinfo}@github.com/acme/widgets.git`,
      "fetch https://[redacted]@github.com/acme/widgets.git",
    ],
    [`secret=${own}`, "secret=[redacted]"],
  ] as const;
  for (const [line, redacted] of cases) {
    expect(redactSecrets(line)).toBe(redacted);
    expect(redactSecrets(redacted)).toBe(redacted);
  }

  const ordinary = `timestamp=2026-10-01T00:00:00.000Z level=WARN fiber=#4 message="token expired" repo=acme/widgets login=octocat sha=${"c0ffee".repeat(6)}abcd remote=ssh://git@github.com/acme/widgets.git`;
  expect(redactSecrets(ordinary)).toBe(ordinary);
});
