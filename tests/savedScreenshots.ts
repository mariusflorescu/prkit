import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { repoRoot } from "../scripts/verify-run.ts";

/**
 * Every screenshot `app.screenshot` saved in the runs on disk. A run keeps them in
 * `.e2e/results`, or in `<output>/results` when it ran with `--output .e2e/proof/<name>`,
 * and a test can't see which, so this looks in each. `relative` is what `app.screenshot`
 * returned (`screenshots/003-overview.png`), and `test` the folder of the test that took it.
 */
export const savedScreenshots = () => {
  const proof = NodePath.join(repoRoot, ".e2e", "proof");
  const folders = [
    NodePath.join(repoRoot, ".e2e", "results"),
    ...(NodeFS.existsSync(proof)
      ? NodeFS.readdirSync(proof).map((name) => NodePath.join(proof, name, "results"))
      : []),
  ].filter((folder) => NodeFS.existsSync(folder));
  return folders.flatMap((folder) =>
    NodeFS.readdirSync(folder).flatMap((test) => {
      const testFolder = NodePath.join(folder, test);
      if (!NodeFS.statSync(testFolder).isDirectory()) return [];
      return NodeFS.readdirSync(testFolder).flatMap((attempt) => {
        const shots = NodePath.join(testFolder, attempt, "screenshots");
        if (!attempt.startsWith("attempt-") || !NodeFS.existsSync(shots)) return [];
        return NodeFS.readdirSync(shots).map((file) => ({
          test,
          file,
          relative: NodePath.posix.join("screenshots", file),
          path: NodePath.join(shots, file),
          savedAt: NodeFS.statSync(NodePath.join(shots, file)).mtimeMs,
        }));
      });
    }),
  );
};
