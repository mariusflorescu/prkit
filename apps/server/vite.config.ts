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
    deps: {
      // Workspace packages export TypeScript source, which Node will not strip under node_modules.
      alwaysBundle: (id: string) => id.startsWith("@prkit/"),
    },
  },
});
