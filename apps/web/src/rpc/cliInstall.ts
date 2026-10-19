import type { CliInstallState, SkillInstallerOpened } from "@prkit/contracts";
import { queryOptions } from "@tanstack/react-query";

import { getCliInstall, installCli, uninstallCli, openSkillInstaller } from "./client";

export const cliInstallQuery = queryOptions({
  queryKey: ["cliInstall"],
  queryFn: getCliInstall,
});

export const changeCliInstall = (
  action: "install" | "uninstall" | "skill",
): Promise<CliInstallState | SkillInstallerOpened> =>
  action === "skill" ? openSkillInstaller() : action === "install" ? installCli() : uninstallCli();
