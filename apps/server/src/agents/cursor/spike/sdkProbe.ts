// @effect-diagnostics globalConsole:off -- a standalone spike script that prints its findings
// Phase-1 spike: what @cursor/sdk does on this machine without spending a model run.
// Run: node apps/server/src/agents/cursor/spike/sdkProbe.ts <fixture-root> <step>
//   status   Cursor.auth.status() against the default and an empty credential store
//   login    Cursor.auth.login() up to the URL, then aborts (never opens a browser)
//   create   Agent.create + send with no key, settingSources [] and the sandbox on
//   hooks    the same with apiKey "invalid", argv[4] "project" or nothing for settingSources
//   models   Cursor.models.list() with whatever credential the SDK finds
// Nothing here signs anyone in or out, and nothing is persisted (store: null).
import { Agent, Cursor, InMemoryCredentialStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";

const [root = "/tmp/u68-fx", step = "status"] = process.argv.slice(2);
const workspace = `${root}/repo`;

const describe = (error: Error) => `${error.name}: ${error.message.slice(0, 300)}`;

const steps: Record<string, () => Promise<void>> = {
  status: async () => {
    console.log("default store:", JSON.stringify(await Cursor.auth.status()));
    console.log(
      "empty store:",
      JSON.stringify(await Cursor.auth.status({ store: new InMemoryCredentialStore() })),
    );
  },
  login: async () => {
    const abort = new AbortController();
    const done = Cursor.auth
      .login({
        openBrowser: false,
        store: null,
        signal: abort.signal,
        onLoginUrl: (url) => {
          const parsed = new URL(url);
          console.log("login url host:", parsed.host, "path:", parsed.pathname);
          console.log("login url params:", [...parsed.searchParams.keys()].join(","));
          abort.abort();
        },
      })
      .then(
        () => console.log("login resolved (unexpected)"),
        (error: Error) => console.log("login stopped:", describe(error)),
      );
    await done;
  },
  create: async () => {
    try {
      const agent = await Agent.create({
        model: { id: "composer-2.5-fast" },
        local: { cwd: workspace, settingSources: [], sandboxOptions: { enabled: true } },
      });
      console.log("created agent", agent.agentId);
      const run = await agent.send("Reply with the word ok.");
      console.log("run status", run.status, JSON.stringify(await run.wait()).slice(0, 300));
      agent.close();
    } catch (error) {
      if (error instanceof Error) console.log("create/send failed:", describe(error));
      else throw error;
    }
  },
  // Same as create, but with project settings on or off and the agent store kept
  // under the fixture, to see whether a project hook fires before auth fails.
  hooks: async () => {
    const sources = process.argv[4] === "project" ? (["project"] as const) : ([] as const);
    const store = await SqliteLocalAgentStore.open({
      workspaceRef: workspace,
      stateRoot: `${root}/sdk-state`,
    });
    try {
      const agent = await Agent.create({
        apiKey: "invalid-probe-key",
        model: { id: "composer-2.5-fast" },
        local: {
          cwd: workspace,
          store,
          settingSources: [...sources],
          sandboxOptions: { enabled: true },
        },
      });
      const run = await agent.send("Reply with the word ok.");
      console.log(`settingSources=${JSON.stringify(sources)}`, (await run.wait()).status);
      agent.close();
    } catch (error) {
      if (error instanceof Error) console.log("hooks probe failed:", describe(error));
      else throw error;
    } finally {
      await store.dispose();
    }
  },
  models: async () => {
    try {
      const models = await Cursor.models.list();
      console.log(models.length, "models");
    } catch (error) {
      if (error instanceof Error) console.log("models failed:", describe(error));
      else throw error;
    }
  },
};

const run = steps[step];
if (run === undefined) throw new Error(`unknown step ${step}`);
await run();
