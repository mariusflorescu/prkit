// Command line options of scripts/fake-github.ts.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export const { values } = NodeUtil.parseArgs({
  options: {
    home: { type: "string" },
    port: { type: "string", default: "0" },
    "no-stacks": { type: "boolean", default: false },
    "second-account": { type: "boolean", default: false },
  },
});
if (values.home === undefined) throw new Error("Pass --home <dir> for the fake gh config.");
export const home = NodePath.resolve(values.home);

export const STACKS = !values["no-stacks"];
