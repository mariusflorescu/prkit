export interface NewLink {
  readonly path: string;
  readonly kind: "symlink" | "submodule";
}

/**
 * What prkit never commits when an agent made or changed it, by its mode in git: a symlink,
 * or a gitlink (a submodule's commit), which makes git read another repository at that path.
 */
const kindOf = (mode: string): NewLink["kind"] | null =>
  mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : null;

/** The paths one `git diff --raw --no-renames -z` shows as a symlink or gitlink on its new side. */
const linksIn = (raw: string) => {
  const tokens = raw.split("\0");
  const links: Array<NewLink> = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const [, mode = ""] = (tokens[index] ?? "").split(" ");
    const kind = kindOf(mode);
    if (kind !== null) links.push({ path: tokens[index + 1] ?? "", kind });
  }
  return links;
};

/**
 * The symlinks and gitlinks a commit would hold that none of its sources holds the same
 * way, from `git diff --cached --raw --no-renames -z --ignore-submodules=none <source>`
 * against each source: one an agent made or changed, which prkit never commits
 * (docs/internals/fix-agent.md).
 */
export const newLinks = (diffs: ReadonlyArray<string>) => {
  const [first = [], ...rest] = diffs.map(linksIn);
  return first.filter((link) =>
    rest.every((links) => links.some((other) => other.path === link.path)),
  );
};

const named = (links: ReadonlyArray<NewLink>, kind: NewLink["kind"]) => {
  const paths = links.filter((link) => link.kind === kind).map((link) => link.path);
  return paths.length === 0
    ? null
    : `the ${kind}${paths.length === 1 ? "" : "s"} ${paths.slice(0, 5).join(", ")}`;
};

/** Why prkit committed nothing, in words the owner reads in the Fixes tab. */
export const linksRefusal = (links: ReadonlyArray<NewLink>) => {
  const symlinks = named(links, "symlink");
  const submodules = named(links, "submodule");
  const why =
    submodules === null
      ? "prkit never commits a link an agent wrote, because it could point anywhere on your machine"
      : symlinks === null
        ? "prkit never commits a submodule an agent wrote, because git would read another repository there"
        : "prkit never commits either from an agent, because a link could point anywhere on your machine and a submodule makes git read another repository";
  return `The agent made or changed ${[symlinks, submodules].filter((part) => part !== null).join(" and ")}. ${why}, so nothing was committed.`;
};
