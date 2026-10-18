/**
 * A stand-in for Claude Code, so a journey can write a guide without a subscription. prkit
 * runs it through PRKIT_CLAUDE_PATH (`verify-app start --claude <file>`); `tests/fakeClaude.ts`
 * writes the wrapper that runs this script with FAKE_CLAUDE_DIR set.
 *
 *   claude --version                a version every bundled model accepts
 *   claude auth status --json       signed in with a Claude Max subscription, or the plan a
 *                                   `fake-plan` file in CLAUDE_CONFIG_DIR names
 *   claude ... --input-format stream-json
 *       answers the Agent SDK's control requests, says prkit's MCP server is connected, then,
 *       through prkit's own MCP server, reports progress and submits a guide with one chapter
 *       holding every file the prompt lists, and ends the turn. Asked for fixes, it adds
 *       `stand-in.md` and reports every comment fixed; asked to resolve conflicts, it keeps the
 *       first side of every conflict in each file and reports the files resolved.
 *
 * In FAKE_CLAUDE_DIR, a `hold` file keeps the turn writing until the file is removed, a
 * `fail` file ends the turn with an error instead of a guide, and a `split` file gives every
 * file a chapter of its own, titled after the file. A `notes` file, JSON of
 * `{ [path]: [{ line, side, tone, text }] }`, gives those files line notes in the guide,
 * read when the guide is submitted; without it the guide has none. A `file-notes` file,
 * `{ [path]: note }`, gives those files a file note. A `chapters` file, JSON of
 * `[{ title, files: [path], kind?, risk? }]`, splits the guide into those chapters, in that
 * order and with that kind and level, with every file they leave out in a last one. A
 * `manual-check` file holds the guide's `manualCheck` as JSON; without it the guide has nothing
 * to check by hand. When the prompt asks for the author's pre-flight, the guide sends the JSON a
 * `preflight` file holds as it is, or `{}` (nothing to flag) without one. A `flow` file holds the
 * guide's `flow` as JSON. With a `draft` file, the turn drafts first, as an agent that can't stream
 * its guide does: `submit_draft` with the overview and every chapter's id and title, then, once
 * no `draft-hold` file is left, the first chapter, then, once no `chapter-hold` file is left,
 * the guide. An `edits` file, JSON
 * of `{ [path]: content }`, has the next fixes write those files besides `stand-in.md`. Before a
 * fix or resolution reports, it also plants what these files ask for, as something outside
 * prkit's sandboxes could:
 *
 *   nested    an empty git repository at the path the file holds, inside the checkout
 *   todo      the rest of the stopped rebase's todo, in reverse
 *   linger    a `sleep` that a command left in the background; the command runs in a session
 *             of its own for a second, as Claude Code runs commands. Its PID goes in `linger.pid`
 *
 * Every turn appends `{configDir, session, resumed}` to `runs.log` there, and its prompt to
 * `prompts.jsonl` with a copy of the context file the prompt names (`context-<turn>.json`).
 * With CLAUDE_CONFIG_DIR set to a folder under `.e2e/`, it also saves the session as Claude Code
 * does, under `projects/`, so prkit can resume it with `--resume`. Any other folder is the user's
 * own: it saves nothing.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const args = process.argv.slice(2);
const write = (message: Schema.Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (args[0] === "--version") {
  process.stdout.write("2.1.999 (Claude Code)\n");
  process.exit(0);
}
const configDir = process.env.CLAUDE_CONFIG_DIR ?? null;
if (args[0] === "auth" && args[1] === "status") {
  const planFile = configDir === null ? null : NodePath.join(configDir, "fake-plan");
  write({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType:
      planFile !== null && NodeFS.existsSync(planFile)
        ? NodeFS.readFileSync(planFile, "utf8").trim()
        : "max",
  });
  process.exit(0);
}

const control = process.env.FAKE_CLAUDE_DIR ?? "";
const flagged = (name: string) => control !== "" && NodeFS.existsSync(NodePath.join(control, name));

const McpConfig = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(
      Schema.String,
      Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
    ),
  }),
);
const configArg = args[args.indexOf("--mcp-config") + 1] ?? "";
const prkit = Schema.decodeOption(McpConfig)(configArg).pipe(
  Option.flatMap((config) => Option.fromNullishOr(config.mcpServers.prkit)),
);
// The SDK passes the header as `${VAR}`; Claude Code reads it from its environment.
const headers = Option.match(prkit, {
  onNone: () => ({}),
  onSome: (server) =>
    Object.fromEntries(
      Object.entries(server.headers).map(([name, value]) => [
        name,
        value.replace(/\$\{(\w+)\}/g, (_, variable: string) => process.env[variable] ?? ""),
      ]),
    ),
});

const Line = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("control_request"),
      request_id: Schema.String,
      request: Schema.Struct({ subtype: Schema.String }),
    }),
    Schema.Struct({
      type: Schema.Literal("user"),
      message: Schema.Struct({
        content: Schema.Union([
          Schema.String,
          Schema.Array(
            Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
          ),
        ]),
      }),
    }),
  ]),
);
const Notes = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        line: Schema.Int,
        side: Schema.Literals(["additions", "deletions"]),
        tone: Schema.Literals(["note", "question", "risk"]),
        text: Schema.String,
      }),
    ),
  ),
);
const Chapters = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      title: Schema.String,
      files: Schema.Array(Schema.String),
      kind: Schema.optionalKey(
        Schema.Literals(["core", "supporting", "data", "config", "tests", "docs", "generated"]),
      ),
      risk: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
    }),
  ),
);
const FileNotes = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const Edits = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const ManualCheckJson = Schema.fromJsonString(
  Schema.Struct({
    setup: Schema.optionalKey(Schema.String),
    steps: Schema.Array(
      Schema.Struct({
        action: Schema.String,
        expect: Schema.String,
        watchFor: Schema.optionalKey(Schema.String),
        chapter: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
      }),
    ),
    reason: Schema.optionalKey(Schema.String),
  }),
);
const McpReply = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optionalKey(Schema.Struct({ isError: Schema.optionalKey(Schema.Boolean) })),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  }),
);

/** The SDK passes `--resume=<id>`; the CLI also takes `--resume <id>`. */
const resumed =
  args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length) ??
  (args.includes("--resume") ? (args[args.indexOf("--resume") + 1] ?? null) : null);
const sessionId = resumed ?? NodeCrypto.randomUUID();
/** Which folder this turn ran with, and the session it saved there as Claude Code would. */
const record = () => {
  if (control !== "")
    NodeFS.appendFileSync(
      NodePath.join(control, "runs.log"),
      `${JSON.stringify({ configDir, session: sessionId, resumed: resumed !== null })}\n`,
    );
  const scratch = NodePath.resolve(import.meta.dirname, "..", ".e2e") + NodePath.sep;
  if (configDir === null || !NodePath.resolve(configDir).startsWith(scratch)) return;
  const project = NodePath.join(
    configDir,
    "projects",
    process.cwd().replaceAll(/[^a-zA-Z0-9]/g, "-"),
  );
  NodeFS.mkdirSync(project, { recursive: true });
  NodeFS.appendFileSync(
    NodePath.join(project, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "summary", sessionId })}\n`,
  );
};
let mcpSession: string | null = null;
let nextId = 1;
/** One JSON-RPC call to prkit's MCP server; the answer comes as JSON or as one SSE event. */
const mcp = async (method: string, params: Schema.Json, notification = false) => {
  const url = Option.match(prkit, { onNone: () => "", onSome: (server) => server.url });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(mcpSession === null ? {} : { "mcp-session-id": mcpSession }),
    },
    body: JSON.stringify(
      notification
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id: nextId++, method, params },
    ),
  });
  mcpSession = response.headers.get("mcp-session-id") ?? mcpSession;
  const text = await response.text();
  if (notification) return { ok: response.ok, text };
  const body = text.includes("data:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("")
    : text;
  const reply = Schema.decodeOption(McpReply)(body);
  const ok =
    response.ok &&
    Option.isSome(reply) &&
    reply.value.error === undefined &&
    reply.value.result?.isError !== true;
  return { ok, text: body };
};

const changedFiles = (prompt: string) => {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => /^Changed files \(\d+\):$/.test(line));
  return lines.slice(start + 1).flatMap((line) => {
    const match = /^- (?:added|modified|removed|renamed) (?:.+ -> )?(.+?) \(\+\d+ -\d+/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
};

const riskOf = (prompt: string) => {
  const level = prompt.includes("- Look closely:") ? "medium" : "low";
  return {
    chapter: (paths: ReadonlyArray<string>) => ({
      level,
      reasons: [{ text: "The stand-in agent rates every change alike.", file: paths[0] ?? "" }],
    }),
    guide: { level, reasons: [{ text: "The stand-in agent read the first chapter.", chapter: 1 }] },
  };
};

const finish = (error: string | null) => {
  write({
    type: "result",
    subtype: error === null ? "success" : "error_during_execution",
    is_error: error !== null,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: error ?? "Submitted the guide.",
    errors: error === null ? [] : [error],
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
    uuid: NodeCrypto.randomUUID(),
  });
  setTimeout(() => process.exit(0), 200);
};

/** What the control folder asks a fix or resolution to leave behind. */
const plant = async () => {
  const cleanGit = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (flagged("nested")) {
    const at = NodeFS.readFileSync(NodePath.join(control, "nested"), "utf8").trim();
    NodeChildProcess.execFileSync("git", ["init", "-q", at], { env: cleanGit, stdio: "ignore" });
  }
  if (flagged("todo")) {
    // The checkout's `.git` file names its git dir, where git keeps the stopped rebase.
    const gitDir = /^gitdir: (.+)$/m.exec(NodeFS.readFileSync(".git", "utf8"))?.[1] ?? "";
    const todo = NodePath.join(gitDir, "rebase-merge", "git-rebase-todo");
    const lines = NodeFS.readFileSync(todo, "utf8").split("\n");
    const steps = lines.filter((line) => line !== "" && !line.startsWith("#"));
    NodeFS.writeFileSync(todo, `${steps.toReversed().join("\n")}\n`);
  }
  if (flagged("linger")) {
    const command = NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", 'sleep 3593 & echo $! > "$1"; sleep 1', "sh", NodePath.join(control, "linger.pid")],
      { detached: true, stdio: "ignore" },
    );
    await new Promise((resolve) => command.once("exit", resolve));
  }
};

const fix = async (prompt: string) => {
  const ids =
    /one entry for each of (.+), (?:then|and) end your turn\./.exec(prompt)?.[1]?.split(", ") ?? [];
  if (prompt.includes("Then call `finish_fixes` again"))
    NodeFS.appendFileSync("stand-in.md", "Revised by the stand-in agent.\n");
  else NodeFS.writeFileSync("stand-in.md", "Written by the stand-in agent.\n");
  if (flagged("edits"))
    for (const [path, content] of Object.entries(
      Schema.decodeSync(Edits)(NodeFS.readFileSync(NodePath.join(control, "edits"), "utf8")),
    ))
      NodeFS.writeFileSync(path, content);
  await plant();
  const reported = await mcp("tools/call", {
    name: "finish_fixes",
    arguments: {
      summary: "Add the stand-in agent's note",
      perComment: ids.map((commentId) => ({
        commentId,
        status: "fixed",
        note: "The stand-in agent added a note.",
      })),
    },
  });
  return finish(reported.ok ? null : `finish_fixes was refused: ${reported.text.slice(0, 300)}`);
};

/** Keeps the first side of every conflict: the lines between `<<<<<<<` and `|||||||` or `=======`. */
const firstSide = (text: string) => {
  const kept: Array<string> = [];
  let side: "none" | "first" | "rest" = "none";
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ")) side = "first";
    else if (side !== "none" && (line.startsWith("|||||||") || line === "=======")) side = "rest";
    else if (side !== "none" && line.startsWith(">>>>>>> ")) side = "none";
    else if (side !== "rest") kept.push(line);
  }
  return kept.join("\n");
};

const resolve = async (prompt: string) => {
  const lines = prompt.split("\n");
  const start = lines.findIndex(
    (line) =>
      line.includes("have conflicts for you to resolve") || line.endsWith("conflicts too, in:"),
  );
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith("- "));
  const files = rest.slice(0, end === -1 ? rest.length : end).map((line) => line.slice(2));
  for (const file of files)
    NodeFS.writeFileSync(file, firstSide(NodeFS.readFileSync(file, "utf8")));
  await plant();
  const reported = await mcp("tools/call", {
    name: "finish_conflicts",
    arguments: {
      summary: "Kept the first side of every conflict.",
      perFile: files.map((path) => ({
        path,
        resolution: "combined",
        note: "The stand-in agent kept the first side.",
      })),
    },
  });
  return finish(
    reported.ok ? null : `finish_conflicts was refused: ${reported.text.slice(0, 300)}`,
  );
};

const keepPrompt = (prompt: string) => {
  if (control === "") return;
  const lines = prompt.split("\n");
  const named = lines.findIndex((line) => line.endsWith("is in this JSON file:"));
  const source = named === -1 ? null : (lines[named + 1] ?? null);
  const turns = NodeFS.existsSync(NodePath.join(control, "prompts.jsonl"))
    ? NodeFS.readFileSync(NodePath.join(control, "prompts.jsonl"), "utf8").split("\n").length - 1
    : 0;
  const copy = source === null ? null : `context-${turns}.json`;
  if (source !== null && copy !== null && NodeFS.existsSync(source))
    NodeFS.copyFileSync(source, NodePath.join(control, copy));
  NodeFS.appendFileSync(
    NodePath.join(control, "prompts.jsonl"),
    `${JSON.stringify({ prompt, context: copy })}\n`,
  );
};

const turn = async (prompt: string) => {
  record();
  keepPrompt(prompt);
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    apiKeySource: "none",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [{ name: "prkit", status: Option.isSome(prkit) ? "connected" : "failed" }],
    model: "claude-fable-5-1",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    uuid: NodeCrypto.randomUUID(),
  });
  await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-claude", version: "0" },
  });
  await mcp("notifications/initialized", {}, true);
  await mcp("tools/call", {
    name: "report_progress",
    arguments: { message: "Reading the change with a stand-in agent" },
  });
  while (flagged("hold")) await new Promise((resolve) => setTimeout(resolve, 200));
  if (flagged("fail")) return finish("The stand-in agent was told to fail.");
  if (prompt.includes("`finish_fixes`")) return fix(prompt);
  if (prompt.includes("`finish_conflicts`")) return resolve(prompt);
  const files = changedFiles(prompt);
  const risk = riskOf(prompt);
  const notes = flagged("notes")
    ? Schema.decodeUnknownSync(Notes)(NodeFS.readFileSync(NodePath.join(control, "notes"), "utf8"))
    : {};
  const fileNotes = flagged("file-notes")
    ? Schema.decodeUnknownSync(FileNotes)(
        NodeFS.readFileSync(NodePath.join(control, "file-notes"), "utf8"),
      )
    : {};
  const manualCheck = flagged("manual-check")
    ? Schema.decodeUnknownSync(ManualCheckJson)(
        NodeFS.readFileSync(NodePath.join(control, "manual-check"), "utf8"),
      )
    : { steps: [], reason: "The stand-in agent never suggests checks." };
  const entryOf = (path: string) => {
    const annotations = notes[path];
    const note = fileNotes[path];
    if (annotations === undefined && note === undefined) return path;
    return {
      path,
      ...(annotations === undefined ? {} : { annotations }),
      ...(note === undefined ? {} : { note }),
    };
  };
  type Planned = {
    title: string;
    kind?: (typeof Chapters.Type)[number]["kind"] | undefined;
    level?: (typeof Chapters.Type)[number]["risk"] | undefined;
    files: ReadonlyArray<string>;
  };
  const groups: ReadonlyArray<Planned> = flagged("split")
    ? files.map((path) => ({ title: `Change in ${path}`, files: [path] }))
    : flagged("chapters")
      ? Schema.decodeSync(Chapters)(
          NodeFS.readFileSync(NodePath.join(control, "chapters"), "utf8"),
        ).map(({ title, files: paths, kind, risk: level }) => ({
          title,
          kind,
          level,
          files: paths.filter((path) => files.includes(path)),
        }))
      : [];
  const placed = new Set(groups.flatMap((chapter) => chapter.files));
  const rest = files.filter((path) => !placed.has(path));
  const chapters: ReadonlyArray<Planned> = [
    ...groups.filter((chapter) => chapter.files.length > 0),
    ...(rest.length > 0
      ? [{ title: groups.length > 0 ? "Every other change" : "Every change", files: rest }]
      : []),
  ];
  const levels: ReadonlyArray<string> = ["low", "medium", "high"];
  // A guide reads at least as carefully as its most careful chapter, or prkit refuses it.
  const guideLevel =
    levels[
      Math.max(
        levels.indexOf(risk.guide.level),
        ...chapters.map((chapter) => levels.indexOf(chapter.level ?? risk.guide.level)),
      )
    ];
  const chapterJson = ({ title, kind, level, files: paths }: Planned) => {
    const chapter = {
      title,
      files: paths.map(entryOf),
      risk:
        level === undefined ? risk.chapter(paths) : { level, reasons: risk.chapter(paths).reasons },
    };
    return kind === undefined ? chapter : { ...chapter, kind };
  };
  const flow = flagged("flow")
    ? {
        flow: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
          NodeFS.readFileSync(NodePath.join(control, "flow"), "utf8"),
        ),
      }
    : {};
  const drafts = flagged("draft");
  // A draft names its chapters before they have files, so the drafts and the guide give ids.
  const named = chapters.map((chapter, index) => ({
    id: `chapter-${index + 1}`,
    ...chapterJson(chapter),
  }));
  const guideChapters = drafts ? named : chapters.map(chapterJson);
  const waitWhile = async (name: string) => {
    while (flagged(name)) await new Promise((resolve) => setTimeout(resolve, 200));
  };
  if (drafts) {
    const overview = await mcp("tools/call", {
      name: "submit_draft",
      arguments: {
        summary: ["A guide written by the stand-in agent."],
        ...flow,
        chapters: named.map(({ id, title }) => ({ id, title })),
      },
    });
    if (!overview.ok) return finish(`submit_draft was refused: ${overview.text.slice(0, 300)}`);
    await waitWhile("draft-hold");
    const first = await mcp("tools/call", {
      name: "submit_draft",
      arguments: { chapters: named.slice(0, 1) },
    });
    if (!first.ok) return finish(`submit_draft was refused: ${first.text.slice(0, 300)}`);
    await waitWhile("chapter-hold");
  }
  const preflight = prompt.includes("so the guide is for its own author")
    ? {
        preflight: flagged("preflight")
          ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
              NodeFS.readFileSync(NodePath.join(control, "preflight"), "utf8"),
            )
          : {},
      }
    : {};
  const submitted = await mcp("tools/call", {
    name: "submit_guide",
    arguments: {
      summary: "A guide written by the stand-in agent.",
      ...flow,
      chapters: guideChapters,
      risk: { level: guideLevel ?? risk.guide.level, reasons: risk.guide.reasons },
      manualCheck,
      focusAreas: [...prompt.matchAll(/^- `([^`]+)` .+: .+$/gm)].map((match) => ({
        id: match[1] ?? "",
        verdict: "nothing-notable",
      })),
      ...preflight,
    },
  });
  return finish(submitted.ok ? null : `submit_guide was refused: ${submitted.text.slice(0, 300)}`);
};

let started = false;
NodeReadline.createInterface({ input: process.stdin }).on("line", (text) => {
  const line = Schema.decodeOption(Line)(text);
  if (Option.isNone(line)) return;
  if (line.value.type === "control_request") {
    write({
      type: "control_response",
      response: { subtype: "success", request_id: line.value.request_id, response: {} },
    });
    return;
  }
  if (started) return;
  started = true;
  const content = line.value.message.content;
  const prompt =
    typeof content === "string" ? content : content.map((block) => block.text ?? "").join("\n");
  void turn(prompt);
});
