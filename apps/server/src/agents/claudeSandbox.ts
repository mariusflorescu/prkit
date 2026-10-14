import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { TurnInput } from "./AgentProvider.ts";
import { commandReads, openPath, realPaths } from "./commandReach.ts";

/**
 * The device files a command's runtime opens (node aborts without `/dev/null`): Claude
 * Code's own list. The owner's terminals (`/dev/ttys*`) stay closed.
 */
const DEVICES = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd",
  "/dev/dtracehelper",
  "/dev/autofs_nowait",
];
/** Where `/bin/sh` reads which shell it is. */
const SHELL_LINKS = "/private/var/select";
/** The link `xcode-select` reads through `/var`, which a closed `/` keeps from it. */
const DEVELOPER_DIR_LINK = "/private/var/select/developer_dir";

/** What a turn's commands may reach, every folder as it really is on disk. */
export interface ClaudeReach {
  /** Read only: the system's folders, the turn's own, git config, script tools. */
  readonly reads: ReadonlyArray<string>;
  /** Folders Claude would let commands write: prkit's for the turn, and a guide's checkout. */
  readonly readOnly: ReadonlyArray<string>;
  readonly checkout: string;
  /** The repository's git data (cache and this worktree's git dir): read, but never written. */
  readonly gitData: ReadonlyArray<string>;
  /** The checkout's `.git` entry: read with the checkout, but never written. */
  readonly gitEntry: string;
  /** The turn's temp folder (`CLAUDE_CODE_TMPDIR`), where commands' TMPDIR lands. */
  readonly tmp: string;
}

/**
 * The sandbox for a turn's commands (docs/internals/architecture.md "Agents"), measured
 * on Claude Code 2.1.296: nothing readable but `reach`, writes only to the turn's temp
 * folder and, for a fix, the checkout, no network. Claude's own allowance would let a
 * command write the rest of the repository's git data (not `<repo>.git/hooks` or
 * `config`), so prkit denies writes to the git data and the checkout's `.git` entry: an
 * agent command can't plant metadata that prkit's own git would read. Claude refuses to
 * run a command if the sandbox can't start.
 */
export const claudeSandbox = (reach: ClaudeReach): SandboxSettings => ({
  enabled: true,
  failIfUnavailable: true,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: false,
  network: { allowedDomains: [], strictAllowlist: true },
  filesystem: {
    denyRead: ["/"],
    allowRead: [
      ...DEVICES,
      SHELL_LINKS,
      ...reach.reads,
      ...reach.gitData,
      reach.checkout,
      reach.tmp,
    ],
    allowWrite: [reach.tmp],
    denyWrite: [...reach.readOnly, ...reach.gitData, reach.gitEntry],
  },
});

/**
 * A turn's sandbox, and the environment its commands need inside it: the temp folder,
 * a PATH of only the folders it opens, and Xcode's developer folder. A guide's commands
 * are also judged by `canUseTool`; the sandbox holds them if that rule has a gap.
 */
export const claudeTurnSandbox = (fs: FileSystem.FileSystem, path: Path.Path, input: TurnInput) =>
  Effect.gen(function* () {
    const tmpDir = input.access.tmpDir;
    const reads = yield* commandReads(fs, path, input);
    const [checkout = input.cwd] = yield* realPaths(fs, [input.cwd]);
    const [tmp = tmpDir] = yield* realPaths(fs, [tmpDir]);
    const reach: ClaudeReach = {
      reads: [...reads.system, ...reads.turn, ...reads.tools],
      readOnly: [
        ...(yield* realPaths(fs, input.readableDirs)),
        ...(input.access._tag === "write" ? [] : [checkout]),
      ],
      checkout,
      gitData: reads.git.data,
      gitEntry: reads.git.entry,
      tmp,
    };
    const developerDir = yield* fs
      .readLink(DEVELOPER_DIR_LINK)
      .pipe(Effect.orElseSucceed(() => null));
    return {
      sandbox: claudeSandbox(reach),
      env: {
        CLAUDE_CODE_TMPDIR: tmpDir,
        TMPDIR: tmpDir,
        PATH: yield* openPath(fs, path, [...reach.reads, checkout, tmp]),
        ...(developerDir === null ? {} : { DEVELOPER_DIR: developerDir }),
      },
    };
  });
