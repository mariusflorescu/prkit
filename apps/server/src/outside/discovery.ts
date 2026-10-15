// @effect-diagnostics-next-line nodeBuiltinImport:off -- The short-lived clients read discovery before an Effect runtime starts.
import * as NodeFs from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolve the discovery path before the runtime starts.
import * as NodePath from "node:path";

import { OUTSIDE_DISCOVERY_FILE, OutsideDiscoveryJson } from "@prkit/contracts/outsideAgents";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownOption(OutsideDiscoveryJson);

export const readTrusted = (home: string) => {
  try {
    const file = NodePath.join(home, OUTSIDE_DISCOVERY_FILE);
    const stat = NodeFs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return null;
    return NodeFs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export const discover = (home: string) => {
  const file = Option.getOrUndefined(decode(readTrusted(home)));
  if (file === undefined) return null;
  try {
    process.kill(file.pid, 0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return null;
  }
  return file;
};
