// @effect-diagnostics-next-line nodeBuiltinImport:off -- effect/FileSystem lists a folder without telling links from files.
import * as NodeFs from "node:fs/promises";

import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

/** Each directory and its real path: macOS reports /tmp paths as /private/tmp. */
export const spellingsOf = (fs: FileSystem.FileSystem, dirs: ReadonlyArray<string>) =>
  Effect.forEach(dirs, (dir) =>
    fs.realPath(dir).pipe(
      Effect.map((real) => [dir, real]),
      Effect.catchTag("PlatformError", () => Effect.succeed([dir])),
    ),
  ).pipe(Effect.map((pairs) => Array.from(new Set(pairs.flat()))));

type Place = "checkout" | "git" | "readable" | "outside";

/**
 * A path a command or tool reads. `option` when the command could take a match of it as
 * an option: anywhere before a command's `--`, never for the Read, Grep and Glob tools.
 */
export interface PathArgument {
  readonly path: string;
  readonly option: boolean;
}

/** What makes the shell expand a word as a pattern: `*?[`, and `^#~` in zsh with `extendedglob`. */
export const PATTERN = /[*?[^#~]/;
const MAX_ALTERNATIVES = 64;
/** The most folder entries one pattern may make prkit list, which `**` in a big tree passes. */
export const MAX_LISTED = 20_000;

/**
 * The words brace expansion makes of a target (`{a,b}.txt` is `a.txt` and `b.txt`), or
 * null for a range (`{1..3}`) or more than MAX_ALTERNATIVES. `{x}` stays as written.
 */
const alternativesOf = (word: string): ReadonlyArray<string> | null => {
  for (let open = word.indexOf("{"); open !== -1; open = word.indexOf("{", open + 1)) {
    const parts: Array<string> = [];
    let depth = 0;
    let start = open + 1;
    for (let at = open + 1; at < word.length; at++) {
      const char = word.charAt(at);
      if (char === "{") depth++;
      else if (char === "}" && depth > 0) depth--;
      else if (char === "," && depth === 0) {
        parts.push(word.slice(start, at));
        start = at + 1;
      } else if (char === "}") {
        if (parts.length === 0) {
          if (word.slice(open + 1, at).includes("..")) return null;
          break;
        }
        parts.push(word.slice(start, at));
        const words: Array<string> = [];
        for (const part of parts) {
          const more = alternativesOf(`${word.slice(0, open)}${part}${word.slice(at + 1)}`);
          if (more === null || words.length + more.length > MAX_ALTERNATIVES) return null;
          words.push(...more);
        }
        return words;
      }
    }
  }
  return [word];
};

/** A pattern segment bash 3.2, sh and dash match to `.` and `..`: `.*`, `.?`, `..*`. */
const matchesDots = (segment: string) => {
  const second = segment.charAt(1);
  return (
    segment.startsWith(".") && PATTERN.test(segment) && (second === "." || PATTERN.test(second))
  );
};

/** A folder's entries; none when it isn't a folder. */
const entriesOf = (dir: string) =>
  Effect.tryPromise(() => NodeFs.readdir(dir, { withFileTypes: true })).pipe(
    Effect.orElseSucceed(() => []),
  );

/**
 * Where a turn's agent may read and write (docs/internals/fix-agent.md "What the
 * agent may do"). A path counts where it really lands, with every symlink in it
 * resolved, so a link in the pull request can't lead outside the checkout. A pattern
 * counts wherever any of its matches could land, since the shell expands it before the
 * command runs. Relative paths resolve against the checkout, or against the directory
 * a command runs in.
 */
export const checkoutPaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  where: {
    readonly checkout: string;
    /** More directories the agent may read, such as the attempt's diffs. */
    readonly readable: ReadonlyArray<string>;
  },
) =>
  Effect.gen(function* () {
    /** Symlinks resolved, then the parts that don't exist yet; null for a link to nowhere or a loop. */
    const realOf = (target: string): Effect.Effect<string | null> =>
      fs.realPath(target).pipe(
        Effect.catchTag("PlatformError", (error) => {
          const parent = path.dirname(target);
          if (error.reason._tag !== "NotFound" || parent === target) return Effect.succeed(null);
          // A link to nothing: writing through it creates its target, wherever that is.
          return fs.readLink(target).pipe(
            Effect.as(null),
            Effect.catchTag("PlatformError", () =>
              realOf(parent).pipe(
                Effect.map((real) =>
                  real === null ? null : path.join(real, path.basename(target)),
                ),
              ),
            ),
          );
        }),
      );
    const rootOf = (dir: string) =>
      realOf(dir).pipe(Effect.map((real) => real ?? path.resolve(dir)));
    const checkout = yield* rootOf(where.checkout);
    const readable = yield* Effect.forEach(where.readable, rootOf);

    const placeOf = (real: string): Place => {
      const under = (root: string) => real === root || real.startsWith(`${root}${path.sep}`);
      if (under(checkout))
        // APFS ignores case, so `.GIT` is the checkout's `.git` link too.
        return path
          .relative(checkout, real)
          .split(path.sep)
          .some((part) => part.toLowerCase() === ".git")
          ? "git"
          : "checkout";
      return readable.some(under) ? "readable" : "outside";
    };
    const place = (target: string, from: string): Effect.Effect<Place> =>
      // The OS reads `link/..` as the link target's parent, path.resolve as the link's;
      // nothing inside a checkout needs `..` or a home path.
      target.startsWith("~") || target.split(/[\\/]/).includes("..")
        ? Effect.succeed("outside")
        : realOf(path.resolve(from, target)).pipe(
            Effect.map((real) => (real === null ? "outside" : placeOf(real))),
          );
    const readableAt = (real: string | null): real is string =>
      real !== null && placeOf(real) !== "outside";

    /**
     * The entries of `dir` a pattern segment could match, taken as any entry at all, each
     * where it really lands; only folders when more segments follow. Null when a link
     * among them leads outside, when `first`, the start of a relative pattern the command
     * could take as options, finds a name like one (`rg x *` beside `--pre=sh`), or when
     * the pattern has listed more than MAX_LISTED entries.
     */
    const matchesIn = (dir: string, first: boolean, folders: boolean, budget: { left: number }) =>
      Effect.gen(function* () {
        const found: Array<string> = [];
        const entries = yield* entriesOf(dir);
        budget.left -= entries.length;
        if (budget.left < 0) return null;
        for (const entry of entries) {
          if (first && entry.name.startsWith("-")) return null;
          const at = path.join(dir, entry.name);
          if (!entry.isSymbolicLink()) {
            if (!folders || entry.isDirectory()) found.push(at);
            continue;
          }
          const real = yield* realOf(at);
          if (!readableAt(real)) return null;
          const folder = yield* fs.stat(real).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          );
          if (!folders || folder) found.push(real);
        }
        return found;
      });

    /** Whether every link under `dir`, at any depth, lands readable: `**`, and zsh's `***` follows links. */
    const subtreeStays = (
      dir: string,
      first: boolean,
      seen: Set<string>,
      budget: { left: number },
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const folders = yield* matchesIn(dir, first, true, budget);
        if (folders === null) return false;
        for (const folder of folders) {
          if (seen.has(folder)) continue;
          seen.add(folder);
          if (!(yield* subtreeStays(folder, false, seen, budget))) return false;
        }
        return true;
      });

    /**
     * Whether every match of a pattern lands readable. Its fixed start resolves like a
     * literal path, then each segment is followed through the folders the shell would
     * read. A plain entry lands in its folder's place, so only links are resolved.
     */
    const patternStays = (pattern: string, from: string, option: boolean) =>
      Effect.gen(function* () {
        const budget = { left: MAX_LISTED };
        const cut = pattern.lastIndexOf("/", pattern.search(PATTERN)) + 1;
        const segments = pattern.slice(cut).split("/");
        if (segments.some(matchesDots)) return false;
        const start = yield* realOf(path.resolve(from, pattern.slice(0, cut) || "."));
        if (!readableAt(start)) return false;
        let dirs: ReadonlyArray<string> = [start];
        for (const [index, segment] of segments.entries()) {
          const first = option && index === 0 && cut === 0;
          if (segment.includes("**")) {
            for (const dir of dirs)
              if (!(yield* subtreeStays(dir, first, new Set(), budget))) return false;
            return true;
          }
          if (segment === "") continue;
          const next: Array<string> = [];
          for (const dir of dirs) {
            if (PATTERN.test(segment)) {
              const found = yield* matchesIn(dir, first, index < segments.length - 1, budget);
              if (found === null) return false;
              next.push(...found);
            } else {
              const real = yield* realOf(path.join(dir, segment));
              if (!readableAt(real)) return false;
              next.push(real);
            }
          }
          dirs = next;
        }
        return true;
      });

    /** A target as written and every word the shell or the Glob tool could expand it to. */
    const reads = ({ path: target, option }: PathArgument, from: string) =>
      Effect.gen(function* () {
        const words = alternativesOf(target);
        if (words === null) return false;
        for (const word of new Set([target, ...words]))
          if ((yield* place(word, from)) === "outside") return false;
        for (const word of words)
          if (PATTERN.test(word) && !(yield* patternStays(word, from, option))) return false;
        return true;
      });

    const every = (targets: ReadonlyArray<string>, from: string, allowed: (at: Place) => boolean) =>
      Effect.forEach(targets, (target) => place(target, from)).pipe(
        Effect.map((places) => places.every(allowed)),
      );
    return {
      /**
       * The first target the agent may not read, or null when each lands in the checkout,
       * its `.git` link, or an extra readable directory, and so does every match of a pattern.
       */
      unreadable: (targets: ReadonlyArray<PathArgument>, from = where.checkout) =>
        Effect.gen(function* () {
          for (const target of targets)
            if (!(yield* reads(target, path.resolve(where.checkout, from)))) return target.path;
          return null;
        }),
      /** A fix may change files in its checkout, never anything named `.git`. */
      writable: (targets: ReadonlyArray<string>) =>
        every(targets, where.checkout, (at) => at === "checkout"),
      /** Where a command may run: the checkout or a folder in it, never its `.git`. */
      runsIn: (directory: string) => every([directory], where.checkout, (at) => at === "checkout"),
    };
  });

export type CheckoutPaths = Effect.Success<ReturnType<typeof checkoutPaths>>;
