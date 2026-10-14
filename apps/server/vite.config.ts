// @effect-diagnostics-next-line nodeBuiltinImport:off -- The build configuration runs outside the Effect runtime.
import { writeFileSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { defineConfig } from "vite-plus";

const buildId = String(Effect.runSync(Clock.currentTimeMillis));

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: false,
      },
    },
  },
  pack: {
    entry: ["src/bin.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    define: { PRKIT_BUILD_ID: JSON.stringify(buildId) },
    onSuccess: () => {
      writeFileSync(new URL("./dist/build.json", import.meta.url), JSON.stringify({ buildId }));
    },
    // Read at runtime next to the bundle (Reviews.ts and Fixers.ts load them from their own directory).
    copy: ["src/reviews/instructions.md", "src/fixers/fix-instructions.md"],
    // Everything but Node's builtins is inlined, so the packaged app ships one self-contained
    // server with no node_modules. The Claude Agent SDK finds its platform binary with a
    // runtime resolve the bundler never follows; prkit always passes the user's own claude.
    deps: {
      alwaysBundle: (id: string) => !id.startsWith("node:"),
      onlyBundle: false,
    },
  },
});
