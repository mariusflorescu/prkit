import { expect, it } from "vite-plus/test";
import { skillInstallCommand, skillTerminalScript } from "./skillCommand.ts";

it("pins the remote skill to the build commit and refuses shell input in build metadata", () => {
  const ref = "a".repeat(40);
  const command = skillInstallCommand("acme/widgets", ref);
  expect(command).toBe(
    `npx skills@1.7.2 add https://github.com/acme/widgets/tree/${ref}/skills --skill prkit-cli`,
  );
  expect(skillInstallCommand("acme/widgets;touch /tmp/no", ref)).toBeNull();
  expect(skillInstallCommand("acme/widgets", "$(echo no)")).toBeNull();
  expect(skillTerminalScript(command ?? "")).toBe(
    `tell application "Terminal"\nactivate\ndo script "${command}"\nend tell`,
  );
});
