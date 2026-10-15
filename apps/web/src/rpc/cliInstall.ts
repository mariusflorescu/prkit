import type { CliInstallState } from "@prkit/contracts";
import { queryOptions } from "@tanstack/react-query";

import { getCliInstall, installCli, uninstallCli, installCliSkill } from "./client";

export const cliInstallQuery = queryOptions({
  queryKey: ["cliInstall"],
  queryFn: getCliInstall,
});

export const changeCliInstall = (
  action: "install" | "uninstall" | "skill",
): Promise<CliInstallState | void> =>
  action === "skill" ? installCliSkill() : action === "install" ? installCli() : uninstallCli();
