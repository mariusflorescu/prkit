import { describe, expect, it } from "vite-plus/test";

import { claudeSandbox } from "./claudeSandbox.ts";

// The PR's own scripts run inside this sandbox on a trusted fix, so it is the boundary.
describe("claudeSandbox", () => {
  it("reads the git data but never writes it or the checkout's .git, writes only the checkout and temp", () => {
    expect(
      claudeSandbox({
        reads: [
          "/System",
          "/opt",
          "/home/me/.prkit/fix-context/t1",
          "/opt/homebrew/Cellar/node/23",
        ],
        readOnly: ["/home/me/.prkit/fix-context/t1"],
        checkout: "/home/me/.prkit/fixes/f1",
        gitData: [
          "/home/me/.prkit/repos/github.com/octocat/widgets.git/worktrees/f1",
          "/home/me/.prkit/repos/github.com/octocat/widgets.git",
        ],
        gitEntry: "/home/me/.prkit/fixes/f1/.git",
        tmp: "/Users/Shared/prkit-4f9c2a",
      }),
    ).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: {
        denyRead: ["/"],
        allowRead: [
          "/dev/null",
          "/dev/zero",
          "/dev/random",
          "/dev/urandom",
          "/dev/stdin",
          "/dev/stdout",
          "/dev/stderr",
          "/dev/fd",
          "/dev/dtracehelper",
          "/dev/autofs_nowait",
          "/private/var/select",
          "/System",
          "/opt",
          "/home/me/.prkit/fix-context/t1",
          "/opt/homebrew/Cellar/node/23",
          "/home/me/.prkit/repos/github.com/octocat/widgets.git/worktrees/f1",
          "/home/me/.prkit/repos/github.com/octocat/widgets.git",
          "/home/me/.prkit/fixes/f1",
          "/Users/Shared/prkit-4f9c2a",
        ],
        allowWrite: ["/Users/Shared/prkit-4f9c2a"],
        denyWrite: [
          "/home/me/.prkit/fix-context/t1",
          "/home/me/.prkit/repos/github.com/octocat/widgets.git/worktrees/f1",
          "/home/me/.prkit/repos/github.com/octocat/widgets.git",
          "/home/me/.prkit/fixes/f1/.git",
        ],
      },
    });
  });
});
