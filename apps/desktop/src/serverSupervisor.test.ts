import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createServerSupervisor } from "./serverSupervisor.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

/** A supervisor over a stand-in server that boots forever: it never prints its ready line. */
const booting = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-supervisor-"));
  homes.push(home);
  const entry = NodePath.join(home, "server.mjs");
  NodeFS.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const exits: Array<string> = [];
  const supervisor = createServerSupervisor({
    start: { entry, home, token: "test-token", target: { _tag: "Built", webDist: home } },
    onUnexpectedExit: (reason) => exits.push(reason),
  });
  return { supervisor, exits };
};

describe("createServerSupervisor", () => {
  it("stops a server that is still booting", async () => {
    const { supervisor, exits } = booting();
    const starting = supervisor.start(0);
    const pid = supervisor.pid();
    expect(pid).toBeDefined();
    if (pid === undefined) return;
    expect(alive(pid)).toBe(true);

    await supervisor.stop();
    await expect(starting).rejects.toThrow("exited before it was ready");
    expect(alive(pid)).toBe(false);
    expect(supervisor.pid()).toBeUndefined();
    expect(exits).toEqual([]);
  });

  it("signals a booting server on quit", async () => {
    const { supervisor } = booting();
    const starting = supervisor.start(0);
    const pid = supervisor.pid();
    if (pid === undefined) throw new Error("the server child was not tracked at spawn");
    supervisor.signalStop();
    await expect(starting).rejects.toThrow("exited before it was ready");
    expect(alive(pid)).toBe(false);
  });
});
