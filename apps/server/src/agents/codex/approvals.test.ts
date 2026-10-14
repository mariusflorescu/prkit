import * as Effect from "effect/Effect";
import * as References from "effect/References";
import type * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { AgentAccess } from "../AgentProvider.ts";
import { makeTestCheckout, removeTestCheckout } from "../testCheckout.ts";
import { makeCodexApprovals } from "./approvals.ts";

const GUIDE: AgentAccess = { _tag: "read-only", tmpDir: "/nowhere" };
const BLOCKED_FIX: AgentAccess = {
  _tag: "write",
  scripts: { _tag: "blocked", reason: "it comes from a fork" },
  tmpDir: "/nowhere",
};

const command = (text: string, cwd: string | null, extra: Record<string, string | null> = {}) => ({
  itemId: "exec-1",
  threadId: "t",
  turnId: "u",
  startedAtMs: 1,
  command: text,
  ...(cwd === null ? {} : { cwd }),
  ...extra,
});
const edit = (id: string, paths: ReadonlyArray<string>) => ({
  item: { type: "fileChange", id, status: "inProgress", changes: paths.map((path) => ({ path })) },
});

// Codex asks before every command and edit in a guide, and in a fix whose pull
// request's scripts don't run. These answers decide what runs; the turn's profile
// holds an accepted command, unless the agent asked to run it outside.
describe("Codex approvals", () => {
  let checkout: Effect.Success<ReturnType<typeof makeTestCheckout>>;
  beforeAll(async () => {
    checkout = await Effect.runPromise(makeTestCheckout());
  });
  afterAll(() => Effect.runPromise(removeTestCheckout(checkout.root)));

  const answerWith = (
    approvals: ReturnType<typeof makeCodexApprovals>,
    method: string,
    params: Schema.Json,
  ) =>
    Effect.runPromise(
      approvals
        .answer(method, params)
        .pipe(Effect.provideService(References.MinimumLogLevel, "None")),
    );
  const decide = (access: AgentAccess, text: string, cwd: string | null) =>
    answerWith(
      makeCodexApprovals(checkout.paths, access),
      "item/commandExecution/requestApproval",
      command(text, cwd),
    );

  it.each([
    ["/bin/zsh -lc 'git diff HEAD -- src/limits.js'", "accept"],
    ['/bin/zsh -lc "rg -n checkUrl src"', "accept"],
    ["cat package.json", "accept"],
    ["/bin/zsh -lc 'cat src/a.js'", "accept"],
    ["/bin/zsh -lc 'npm test'", "decline"],
    ["/bin/zsh -lc 'node test/limits.test.js'", "decline"],
    ["/bin/zsh -lc 'cat package.json' extra", "decline"],
    ["/bin/bash -c 'ls; sh ./scripts/setup.sh'", "decline"],
    ["/bin/zsh -lc 'cat notes.md'", "decline"],
    ["/bin/zsh -lc 'ls linked'", "decline"],
    ["/bin/zsh -lc 'rg -n secret linked/inside.txt'", "decline"],
    ["/bin/zsh -lc 'head -5 /etc/hosts'", "decline"],
    ["/bin/zsh -lc 'cat ~/.zshrc'", "decline"],
  ])("answers %s run in the checkout with %s", async (text, decision) => {
    expect(await decide(BLOCKED_FIX, text, checkout.checkout)).toEqual({ decision });
  });

  it.each([
    ["/bin/zsh -lc 'cat src/*.ts'", "", "accept"],
    [`/bin/zsh -lc "rg foo -g '*.md'"`, "", "accept"],
    ["/bin/zsh -lc 'wc -l *.js'", "src", "accept"],
    ["/bin/zsh -lc 'cat *.md'", "", "decline"],
    ["/bin/zsh -lc 'ls l*'", "", "decline"],
    ["/bin/zsh -lc 'cat .?/secret.txt'", "src", "decline"],
    ["/bin/zsh -lc 'echo ../*'", "", "decline"],
    ["/bin/zsh -lc 'git log -1 -- ../*'", "", "decline"],
    ["/bin/zsh -lc 'rg -g *.js /etc/hosts'", "src", "decline"],
    ["/bin/zsh -lc 'cat =ls'", "", "decline"],
    ["/bin/zsh -lc 'rg zzz *'", "opts", "decline"],
    ["/bin/zsh -lc 'git log *'", "opts", "decline"],
  ])("answers %s run in /%s, where the shell expands it, with %s", async (text, from, decision) => {
    expect(await decide(BLOCKED_FIX, text, `${checkout.checkout}/${from}`)).toEqual({ decision });
  });

  it("judges a relative path where the command runs, and runs nothing outside the checkout", async () => {
    expect(
      await decide(BLOCKED_FIX, "/bin/zsh -lc 'cat a.js'", `${checkout.checkout}/src`),
    ).toEqual({ decision: "accept" });
    expect(
      await Promise.all([
        decide(BLOCKED_FIX, "/bin/zsh -lc 'cat secret.txt'", checkout.outside),
        decide(BLOCKED_FIX, "/bin/zsh -lc 'git log -1'", checkout.outside),
        decide(BLOCKED_FIX, "/bin/zsh -lc 'ls'", `${checkout.checkout}/linked`),
        decide(BLOCKED_FIX, "/bin/zsh -lc 'cat src/a.js'", null),
      ]),
    ).toEqual([
      { decision: "decline" },
      { decision: "decline" },
      { decision: "decline" },
      { decision: "decline" },
    ]);
  });

  it("lets a guide read the checkout and its diffs, and nothing else", async () => {
    expect(
      await Promise.all([
        decide(GUIDE, "/bin/zsh -lc 'cat src/a.js'", checkout.checkout),
        decide(GUIDE, `/bin/zsh -lc 'cat ${checkout.diffs}/numbered.diff'`, checkout.checkout),
        decide(GUIDE, `/bin/zsh -lc 'cat ${checkout.outside}/secret.txt'`, checkout.checkout),
        decide(GUIDE, "/bin/zsh -lc 'npm test'", checkout.checkout),
      ]),
    ).toEqual([
      { decision: "accept" },
      { decision: "accept" },
      { decision: "decline" },
      { decision: "decline" },
    ]);
  });

  // Without a reason an escalation looks like any request, so it is judged by the rule
  // like one; the turn's profile, which lists `/` as none, keeps it to the profile's reads.
  it("declines a command the agent asks to run outside the sandbox, which Codex marks only by its reason", async () => {
    const approvals = makeCodexApprovals(checkout.paths, GUIDE);
    expect(
      await Promise.all([
        answerWith(
          approvals,
          "item/commandExecution/requestApproval",
          command("/bin/zsh -lc 'cat src/a.js'", checkout.checkout, { reason: "needs the cache" }),
        ),
        answerWith(
          approvals,
          "item/commandExecution/requestApproval",
          command("/bin/zsh -lc 'cat src/a.js'", checkout.checkout, { reason: null }),
        ),
      ]),
    ).toEqual([{ decision: "decline" }, { decision: "accept" }]);
  });

  it("declines input to a running command and network access", async () => {
    const approvals = makeCodexApprovals(checkout.paths, BLOCKED_FIX);
    expect(
      await answerWith(
        approvals,
        "item/commandExecution/requestApproval",
        command("cat package.json", checkout.checkout, { kind: "writeStdin" }),
      ),
    ).toEqual({ decision: "decline" });
  });

  it("accepts a fix's edit inside the checkout and declines one in .git, outside it, through a link, or unseen", async () => {
    const approvals = makeCodexApprovals(checkout.paths, BLOCKED_FIX);
    const inside = (file: string) => `${checkout.checkout}/${file}`;
    approvals.seen("item/started", edit("e1", [inside("src/a.js"), inside("src/new.js")]));
    approvals.seen("item/started", edit("e2", [inside("src/a.js"), inside(".git")]));
    approvals.seen("item/started", edit("e3", [`${checkout.outside}/secret.txt`]));
    approvals.seen("item/started", edit("e4", [inside("notes.md")]));
    approvals.seen("item/started", edit("e5", [inside("linked/new.txt")]));
    const answer = (itemId: string) =>
      answerWith(approvals, "item/fileChange/requestApproval", {
        itemId,
        threadId: "t",
        turnId: "u",
      });
    expect(await Promise.all(["e1", "e2", "e3", "e4", "e5", "e6"].map(answer))).toEqual([
      { decision: "accept" },
      { decision: "decline" },
      { decision: "decline" },
      { decision: "decline" },
      { decision: "decline" },
      { decision: "decline" },
    ]);
  });

  it("declines every edit in a guide", async () => {
    const approvals = makeCodexApprovals(checkout.paths, GUIDE);
    approvals.seen("item/started", edit("e1", [`${checkout.checkout}/src/a.js`]));
    expect(
      await answerWith(approvals, "item/fileChange/requestApproval", {
        itemId: "e1",
        threadId: "t",
        turnId: "u",
      }),
    ).toEqual({ decision: "decline" });
  });

  it("leaves other requests to be refused", async () => {
    expect(
      await answerWith(
        makeCodexApprovals(checkout.paths, BLOCKED_FIX),
        "item/permissions/requestApproval",
        { itemId: "p1" },
      ),
    ).toBe(null);
  });
});
