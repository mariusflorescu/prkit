import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Cursor's sandbox for every prkit turn, in the instance's own home (`~/.cursor/sandbox.json`
 * there): reads stay in the turn's folders, writes in the checkout, no temporary folder and
 * no network. With `settingSources: []` the SDK reads no other setting from that home.
 */
const SandboxPolicy = Schema.Struct({
  type: Schema.Literal("workspace_readwrite"),
  readBoundary: Schema.Literal("workspace"),
  disableTmpWrite: Schema.Boolean,
  networkPolicy: Schema.Struct({ default: Schema.Literal("deny") }),
});
export const SANDBOX_POLICY: typeof SandboxPolicy.Type = {
  type: "workspace_readwrite",
  readBoundary: "workspace",
  disableTmpWrite: true,
  networkPolicy: { default: "deny" },
};
const encodePolicy = Schema.encodeSync(Schema.fromJsonString(SandboxPolicy));

/** The instance's home: Cursor's settings, the sign-in's key, and its conversations. */
export const layOutHome = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotCursor = path.join(home, ".cursor");
    yield* fs.makeDirectory(dotCursor, { recursive: true, mode: 0o700 });
    // Where Cursor keeps its transcripts: the one folder a turn writes in, never the folder itself.
    yield* fs.makeDirectory(path.join(dotCursor, "projects"), { recursive: true, mode: 0o700 });
    // The runner's temporary files outside a turn: its sandbox opens no other temp folder.
    yield* fs.makeDirectory(path.join(home, "tmp"), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(
      path.join(dotCursor, "sandbox.json"),
      `${encodePolicy(SANDBOX_POLICY)}\n`,
    );
  });

/**
 * The SDK always reads a workspace's `.cursor/sandbox.json` into its sandbox, setting sources or
 * not, and that file can open reads, writes or the network. So prkit runs Cursor on no folder
 * that has one: checked before every turn, a resumed one too.
 */
export const workspaceSandboxProblem = (dirs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const dir of dirs) {
      const file = path.join(dir, ".cursor", "sandbox.json");
      // A link counts too, and so does a file prkit can't read: only "not there" passes.
      const there = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true));
      const linked = yield* fs.readLink(file).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (there || linked)
        return "This pull request has a .cursor/sandbox.json, which would change Cursor's sandbox, so prkit won't run Cursor on it. Pick another agent for it.";
    }
    return null;
  });
