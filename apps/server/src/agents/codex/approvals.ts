import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AgentAccess } from "../AgentProvider.ts";
import { decideTurnBash, fileArguments, parse } from "../bashPolicy.ts";
import type { CheckoutPaths } from "../checkoutPaths.ts";

const SHELLS = new Set(["sh", "bash", "zsh"]);

/** The script inside a login-shell wrapper (`/bin/zsh -lc 'npm test'`), else the command itself. */
const unwrapShell = (command: string) => {
  const parsed = parse(command);
  if (parsed._tag === "error" || parsed.commands.length !== 1) return command;
  const [shell = "", flag = "", script, ...extra] = parsed.commands[0]?.words ?? [];
  return SHELLS.has(shell.slice(shell.lastIndexOf("/") + 1)) &&
    (flag === "-c" || flag === "-lc") &&
    script !== undefined &&
    extra.length === 0
    ? script
    : command;
};

const decodeFileChange = Schema.decodeUnknownOption(
  Schema.Struct({
    item: Schema.Struct({
      type: Schema.Literal("fileChange"),
      id: Schema.String,
      changes: Schema.Array(Schema.Struct({ path: Schema.String })),
    }),
  }),
);
const decodeCommandRequest = Schema.decodeUnknownOption(
  Schema.Struct({
    command: Schema.optionalKey(Schema.NullOr(Schema.String)),
    cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
    kind: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    networkApprovalContext: Schema.optionalKey(Schema.NullOr(Schema.Json)),
  }),
);
const decodeFileChangeRequest = Schema.decodeUnknownOption(
  Schema.Struct({ itemId: Schema.String }),
);

const answer = (allowed: boolean): Schema.Json => ({ decision: allowed ? "accept" : "decline" });
/** Each answer goes to the server log with what it was about, like Claude's `canUseTool` calls. */
const logged = (allowed: Effect.Effect<boolean>, about: Record<string, string>) =>
  allowed.pipe(
    Effect.tap((accepted) =>
      Effect.logInfo("Codex approval").pipe(
        Effect.annotateLogs({ ...about, decision: accepted ? "accept" : "decline" }),
      ),
    ),
    Effect.map(answer),
  );

/**
 * prkit's answers when Codex asks before running a command or applying an edit
 * (docs/internals/fix-agent.md "What the agent may do"). Under approval policy
 * `untrusted` Codex asks before every command and every edit: the turn's command rule,
 * run from inside the checkout on files inside it, and for a fix, edits inside the
 * checkout, each path judged where it really lands, links resolved. Codex 0.162 runs
 * an accepted command inside prkit's profile, unless the agent asked to run it outside
 * (`require_escalated`): then its request looks the same, but for the reason the agent
 * may give, and the command gets the whole disk but the profile's `none` folders. So a
 * request with a reason is declined, and the profile closes the owner's home
 * (`sandbox.ts`). Anything else is declined and the turn carries on.
 */
export const makeCodexApprovals = (paths: CheckoutPaths, access: AgentAccess) => {
  /** The files of each edit Codex started, by item id; its approval request names only the id. */
  const edits = new Map<string, ReadonlyArray<string>>();
  return {
    /** Every notification, in order, so an edit's files are known before Codex asks about it. */
    seen: (method: string, params: Schema.Json) => {
      if (method !== "item/started") return;
      const started = decodeFileChange(params);
      if (Option.isSome(started))
        edits.set(
          started.value.item.id,
          started.value.item.changes.map((change) => change.path),
        );
    },
    /** The answer to one request from Codex, or null when it isn't an approval prkit gives. */
    answer: (method: string, params: Schema.Json): Effect.Effect<Schema.Json | null> => {
      if (method === "item/commandExecution/requestApproval") {
        const request = decodeCommandRequest(params);
        if (Option.isNone(request)) return logged(Effect.succeed(false), { method });
        const {
          command,
          cwd,
          kind = "command",
          networkApprovalContext = null,
          reason = null,
        } = request.value;
        const script = typeof command === "string" ? unwrapShell(command) : null;
        const about = { command: (script ?? "").slice(0, 200), cwd: cwd ?? "" };
        if (
          script === null ||
          typeof cwd !== "string" ||
          kind !== "command" ||
          networkApprovalContext !== null ||
          (reason !== null && reason !== "") ||
          !decideTurnBash(script, access).allow
        )
          return logged(Effect.succeed(false), about);
        // A relative path names a file where the command runs, which Codex lets the agent choose.
        return logged(
          Effect.all([paths.runsIn(cwd), paths.unreadable(fileArguments(script), cwd)]).pipe(
            Effect.map(([runs, outside]) => runs && outside === null),
          ),
          about,
        );
      }
      if (method === "item/fileChange/requestApproval") {
        const files = decodeFileChangeRequest(params).pipe(
          Option.flatMap((request) => Option.fromNullishOr(edits.get(request.itemId))),
        );
        const about = { files: Option.getOrElse(files, () => []).join(", ") };
        if (access._tag === "read-only" || Option.isNone(files) || files.value.length === 0)
          return logged(Effect.succeed(false), about);
        return logged(paths.writable(files.value), about);
      }
      return Effect.succeed(null);
    },
  };
};

export type CodexApprovals = ReturnType<typeof makeCodexApprovals>;
