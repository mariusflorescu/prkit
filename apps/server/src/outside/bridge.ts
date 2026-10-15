// The bridge runs as its own short-lived process for one MCP client, before and without the
// server's Effect runtime, and relays JSON-RPC lines it must not rewrite.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  cleanClientName,
  OUTSIDE_BRIDGE_HEADER,
  OUTSIDE_CLIENT_HEADER,
  OUTSIDE_DISCOVERY_FILE,
  OUTSIDE_MCP_PATH,
  OUTSIDE_NOT_OPEN,
  OUTSIDE_OFF,
  OutsideDiscoveryJson,
} from "@prkit/contracts/outsideAgents";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { OUTSIDE_OFFLINE_INSTRUCTIONS } from "./instructions.ts";

/**
 * `prkit-mcp`: a stdio MCP server that relays each JSON-RPC line to prkit's outside endpoint
 * (streamable HTTP), with SSE, `mcp-session-id` and the protocol version.
 *
 * prkit's port and token change on every launch, so the bridge reads both from the discovery
 * file, never from argv or the client's config. When prkit restarts or the token changes
 * (connection refused, a 401, an unknown session), it reads the file again and replays the
 * client's `initialize` on a new session, and the client never notices. When prkit isn't open
 * or the switch is off, it answers itself: one `prkit_status` tool that says so, and
 * `notifications/tools/list_changed` once that changes. It never opens a window and never
 * touches `prkit.lock`.
 */

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-11-25"];
const WATCH_INTERVAL_MS = 2000;

const Envelope = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Json),
});
type Envelope = typeof Envelope.Type;
type RequestId = string | number | null;
const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));
const decodeInitializeParams = Schema.decodeUnknownOption(
  Schema.Struct({
    protocolVersion: Schema.optionalKey(Schema.String),
    clientInfo: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  }),
);
const decodeInitializeResult = Schema.decodeUnknownOption(
  Schema.Struct({ protocolVersion: Schema.String }),
);
const decodeDiscovery = Schema.decodeUnknownOption(OutsideDiscoveryJson);

type Upstream = {
  readonly port: number;
  readonly token: string;
  session: string | null;
  protocol: string | null;
};
type Reachable = { readonly _tag: "on"; readonly port: number; readonly token: string };
type Unreachable = { readonly _tag: "off" | "not-open" };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const runBridge = async (home: string) => {
  const discoveryPath = NodePath.join(home, OUTSIDE_DISCOVERY_FILE);
  const bridgeId = NodeCrypto.randomUUID();
  const write = (message: string) => {
    process.stdout.write(`${message}\n`);
  };
  const send = (message: object) => write(JSON.stringify(message));

  /** The file as it says now; a missing, damaged or stale (dead pid) file means not open. */
  const discover = (): Reachable | Unreachable => {
    let text: string;
    try {
      text = NodeFs.readFileSync(discoveryPath, "utf8");
    } catch {
      return { _tag: "not-open" };
    }
    const file = Option.getOrUndefined(decodeDiscovery(text));
    if (file === undefined || !alive(file.pid)) return { _tag: "not-open" };
    return file._tag === "off"
      ? { _tag: "off" }
      : { _tag: "on", port: file.port, token: file.token };
  };
  /** What changes the tools a client should see: reachable or not, and the level. */
  const fingerprint = () => {
    let text = "";
    try {
      text = NodeFs.readFileSync(discoveryPath, "utf8");
    } catch {
      return "not-open";
    }
    const file = Option.getOrUndefined(decodeDiscovery(text));
    if (file === undefined || !alive(file.pid)) return "not-open";
    return file._tag === "off" ? "off" : `on:${file.access}`;
  };

  let clientName = cleanClientName("");
  let initializeLine: string | null = null;
  let requestedProtocol = SUPPORTED_PROTOCOLS[0] ?? "2025-06-18";
  let clientInitialized = false;
  let upstream: Upstream | null = null;
  let connecting: Promise<Upstream | Unreachable> | null = null;

  const post = (target: Upstream, body: string) =>
    fetch(`http://127.0.0.1:${target.port}${OUTSIDE_MCP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${target.token}`,
        [OUTSIDE_CLIENT_HEADER]: clientName,
        [OUTSIDE_BRIDGE_HEADER]: bridgeId,
        ...(target.session === null ? {} : { "mcp-session-id": target.session }),
        ...(target.protocol === null ? {} : { "mcp-protocol-version": target.protocol }),
      },
      body,
    });

  /** The JSON-RPC messages of one answer, from a JSON body or an SSE stream. */
  const payloads = async (response: Response) => {
    const text = await response.text();
    const lines = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n"),
        )
      : text.split("\n");
    return lines.filter((line) => line.trim() !== "");
  };

  /** A session on whatever prkit the file names now, with the client's own `initialize` replayed. */
  const open = async (): Promise<Upstream | Unreachable> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = discover();
      if (found._tag !== "on") return found;
      const target: Upstream = {
        port: found.port,
        token: found.token,
        session: null,
        protocol: null,
      };
      if (initializeLine === null) return target;
      try {
        const response = await post(target, initializeLine);
        if (!response.ok) {
          await response.body?.cancel();
          // The token moved between reading the file and this call: read it once more.
          if (response.status === 401) continue;
          // 403: the switch went off since the file was read.
          const now = discover();
          return now._tag === "off" ? now : { _tag: "not-open" };
        }
        target.session = response.headers.get("mcp-session-id");
        for (const line of await payloads(response)) {
          const result = Option.getOrUndefined(decodeEnvelope(line))?.result;
          const negotiated = Option.getOrUndefined(decodeInitializeResult(result));
          if (negotiated !== undefined) target.protocol = negotiated.protocolVersion;
        }
        if (clientInitialized) {
          const ack = await post(target, '{"jsonrpc":"2.0","method":"notifications/initialized"}');
          await ack.body?.cancel();
        }
        return target;
      } catch {
        return { _tag: "not-open" };
      }
    }
    return { _tag: "not-open" };
  };

  /** One connection attempt at a time; later callers share it. */
  const connect = () => {
    connecting ??= open().then((result) => {
      connecting = null;
      upstream = "port" in result ? result : null;
      return result;
    });
    return connecting;
  };

  const unreachableMessage = (reason: Unreachable) =>
    reason._tag === "off" ? OUTSIDE_OFF : OUTSIDE_NOT_OPEN;

  /** prkit's answer while it can't answer itself. */
  const answerLocally = (envelope: Envelope, reason: Unreachable) => {
    const id = envelope.id;
    if (id === undefined) return;
    const message = unreachableMessage(reason);
    const reply = (result: object) => send({ jsonrpc: "2.0", id, result });
    switch (envelope.method) {
      case "initialize":
        return reply({
          protocolVersion: requestedProtocol,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "prkit", version: packageJson.version },
          instructions: OUTSIDE_OFFLINE_INSTRUCTIONS,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: [
            {
              name: "prkit_status",
              description: `Whether prkit can be reached. ${message}`,
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "tools/call":
        return reply({ content: [{ type: "text", text: message }], isError: true });
      default:
        return send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
    }
  };

  const failed = (id: RequestId, method: string | undefined, message: string) =>
    method === "tools/call"
      ? send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: message }], isError: true },
        })
      : send({ jsonrpc: "2.0", id, error: { code: -32603, message } });

  const forward = async (line: string, envelope: Envelope) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = upstream ?? (await connect());
      if (!("port" in target)) return answerLocally(envelope, target);
      let response: Response;
      try {
        response = await post(target, line);
      } catch {
        // Connection refused: prkit quit or restarted on another port.
        if (upstream === target) upstream = null;
        continue;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        // A new token, the switch going off, or a session the server no longer knows.
        await response.body?.cancel();
        if (upstream === target) upstream = null;
        continue;
      }
      if (envelope.method === "initialize")
        target.session = response.headers.get("mcp-session-id") ?? target.session;
      if (!response.ok) {
        await response.body?.cancel();
        if (envelope.id !== undefined)
          failed(
            envelope.id,
            envelope.method,
            `prkit answered with HTTP ${response.status}. Try again.`,
          );
        return;
      }
      for (const payload of await payloads(response)) {
        if (envelope.method === "initialize") {
          const result = Option.getOrUndefined(decodeEnvelope(payload))?.result;
          const negotiated = Option.getOrUndefined(decodeInitializeResult(result));
          if (negotiated !== undefined) target.protocol = negotiated.protocolVersion;
        }
        write(payload);
      }
      return;
    }
    const reason = discover();
    if (reason._tag === "on") {
      if (envelope.id !== undefined)
        failed(envelope.id, envelope.method, "prkit didn't answer. Try again.");
      return;
    }
    answerLocally(envelope, reason);
  };

  const running = new Set<Promise<void>>();
  const track = (work: Promise<void>) => {
    running.add(work);
    void work.finally(() => running.delete(work));
  };

  // The handshake runs in order; every later call runs as it comes.
  let handshake: Promise<void> = Promise.resolve();
  const dispatch = (line: string) => {
    if (line.trim() === "") return;
    const envelope = Option.getOrUndefined(decodeEnvelope(line));
    if (envelope === undefined)
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    if (envelope.method === "initialize") {
      const params = Option.getOrUndefined(decodeInitializeParams(envelope.params));
      clientName = cleanClientName(params?.clientInfo?.name ?? "");
      const asked = params?.protocolVersion;
      requestedProtocol =
        asked !== undefined && SUPPORTED_PROTOCOLS.includes(asked) ? asked : requestedProtocol;
      // The client's own initialize opens the session; it is replayed only on a new one.
      handshake = handshake.then(async () => {
        initializeLine = null;
        upstream = null;
        await forward(line, envelope);
        initializeLine = line;
      });
      return track(handshake);
    }
    if (envelope.method === "notifications/initialized") {
      clientInitialized = true;
      handshake = handshake.then(async () => {
        const target = upstream;
        if (target === null) return;
        try {
          const response = await post(target, line);
          await response.body?.cancel();
        } catch {
          upstream = null;
        }
      });
      return track(handshake);
    }
    track(handshake.then(() => forward(line, envelope)));
  };

  // prkit opening, quitting, or changing its access changes the tools; the client asks again.
  let seen = fingerprint();
  const watcher = setInterval(() => {
    const now = fingerprint();
    if (now === seen) return;
    seen = now;
    upstream = null;
    if (clientInitialized) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }, WATCH_INTERVAL_MS);
  watcher.unref();

  const reader = NodeReadline.createInterface({ input: process.stdin });
  for await (const line of reader) dispatch(line);
  await Promise.allSettled(running);
  clearInterval(watcher);
};

/** The `mcp-bridge` subcommand: PRKIT_HOME from the launcher, else `~/.prkit`. */
export const main = async () => {
  const home = NodePath.resolve(
    process.env.PRKIT_HOME ?? NodePath.join(process.env.HOME ?? "", ".prkit"),
  );
  await runBridge(home);
};
