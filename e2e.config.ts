import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

// The runner passes the app command only PATH, HOME and TMPDIR. The server reads the
// user's gh config and keychain, so it also gets the login name and locale, and each
// agent's config folder: real-agent journeys spend whichever Claude account the caller's
// shell points at. Stand-in agents never write to it.
const passThrough = Object.fromEntries(
  ["USER", "LOGNAME", "LANG", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }),
);

export default {
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      name: "web",
      engine: web(),
      app: {
        // Port 0: every run and every MCP session gets its own instance and home.
        url: "http://127.0.0.1:0",
        readyUrl: "http://127.0.0.1:{port}/health",
        command: {
          executable: process.execPath,
          args: [
            "scripts/verify-app.ts",
            "start",
            "--name",
            "e2e-{port}",
            "--port",
            "{port}",
            "--rm",
            // Watcher journeys wait for ticks; 5 seconds instead of the app's 60. Only
            // `--e2e` instances may go under the server's 60-second floor.
            "--watch-interval",
            "5000",
            "--e2e",
          ],
          env: passThrough,
          log: ".e2e/logs/e2e-runner.log",
          shutdownTimeout: 15_000,
        },
      },
    },
  ],
  workers: 1,
  retries: 0,
  trace: "retain-on-failure",
  video: "retain-on-failure",
} satisfies E2EConfig;
