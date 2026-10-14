import { defineConfig } from "vite-plus";

// Electron's main and preload run as CommonJS. Everything but electron itself is bundled,
// and the sandboxed preload must be a single self-contained file.
const bundleAllButElectron = {
  alwaysBundle: (id: string) => !id.startsWith("node:") && id !== "electron",
  neverBundle: (id: string) => id === "electron",
  onlyBundle: false,
} as const;

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: ["@prkit/server#build", "@prkit/web#build"],
        cache: false,
      },
    },
  },
  pack: ["src/main.ts", "src/preload.ts"].map((entry, index) => ({
    entry: [entry],
    format: "cjs",
    outDir: "dist-electron",
    outExtensions: () => ({ js: ".cjs" }),
    outputOptions: { codeSplitting: false },
    dts: false,
    sourcemap: true,
    clean: index === 0,
    deps: bundleAllButElectron,
  })),
});
