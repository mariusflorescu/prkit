const BOOLEAN = ["true", "false"];

/**
 * Every key a repository cache's config may hold, with the values it may take: what
 * `git init --bare` writes (a case-insensitive or Unicode-normalizing volume adds the last two
 * core keys) and the three prkit sets in `ensureCache`. A partial-clone fetch may also register
 * the remote under `extensions`. `required` keys are in every cache prkit made.
 */
const ALLOWED = (url: string) =>
  new Map<string, { readonly values: ReadonlyArray<string>; readonly required: boolean }>([
    ["core.repositoryformatversion", { values: ["0", "1"], required: true }],
    ["core.filemode", { values: BOOLEAN, required: false }],
    ["core.bare", { values: ["true"], required: true }],
    ["core.ignorecase", { values: BOOLEAN, required: false }],
    ["core.precomposeunicode", { values: BOOLEAN, required: false }],
    ["extensions.partialclone", { values: ["origin"], required: false }],
    ["remote.origin.url", { values: [url], required: true }],
    ["remote.origin.promisor", { values: ["true"], required: true }],
    ["remote.origin.partialclonefilter", { values: ["blob:none"], required: true }],
  ]);

/**
 * The keys of a cache's config that are not exactly prkit's own, from
 * `git config --file <cache>/config --no-includes --list -z`: one prkit didn't write (an
 * `include.path`, `url.*.insteadOf`, `filter.*`, `http.*` and every other), one with a value
 * prkit didn't write or written twice, and one of prkit's that is gone. Any of them could make
 * prkit's git run a program or send the account's token to another server.
 */
export const foreignConfigKeys = (listed: string, url: string) => {
  const allowed = ALLOWED(url);
  const seen = new Map<string, number>();
  const foreign = new Set<string>();
  for (const entry of listed.split("\0").filter((item) => item !== "")) {
    const newline = entry.indexOf("\n");
    // A key with no `=` is git's shorthand for true, and is never one prkit writes.
    const [key, value] =
      newline === -1 ? [entry, null] : [entry.slice(0, newline), entry.slice(newline + 1)];
    seen.set(key, (seen.get(key) ?? 0) + 1);
    const rule = allowed.get(key);
    if (rule === undefined || value === null || !rule.values.includes(value)) foreign.add(key);
  }
  for (const [key, count] of seen) if (count > 1) foreign.add(key);
  for (const [key, rule] of allowed) if (rule.required && !seen.has(key)) foreign.add(key);
  return [...foreign];
};
