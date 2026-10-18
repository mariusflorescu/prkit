type GlobToken = { kind: "star" } | { kind: "character"; matches: (char: string) => boolean };

const classMatches = (contents: string, char: string) => {
  const negated = contents.startsWith("!");
  const chars = Array.from(negated ? contents.slice(1) : contents);
  let matched = false;
  for (let i = 0; i < chars.length; i++) {
    const low = chars[i];
    const high = chars[i + 2];
    if (low === undefined) continue;
    if (chars[i + 1] === "-" && high !== undefined) {
      matched ||= low <= char && char <= high;
      i += 2;
    } else {
      matched ||= low === char;
    }
  }
  return negated ? !matched : matched;
};

export const globTokens = (pattern: string) => {
  const chars = Array.from(pattern);
  const tokens: Array<GlobToken> = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === undefined) continue;
    if (char === "*") {
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
    } else if (char === "?") {
      tokens.push({ kind: "character", matches: () => true });
    } else if (char === "[") {
      let end = i + 1;
      if (chars[end] === "!") end++;
      if (chars[end] === "]") end++;
      while (end < chars.length && chars[end] !== "]") end++;
      if (end === chars.length) {
        tokens.push({ kind: "character", matches: (value) => value === "[" });
      } else {
        const contents = chars.slice(i + 1, end).join("");
        tokens.push({ kind: "character", matches: (value) => classMatches(contents, value) });
        i = end;
      }
    } else {
      tokens.push({ kind: "character", matches: (value) => value === char });
    }
  }
  return tokens;
};

export const matchesGlob = (path: string, tokens: ReadonlyArray<GlobToken>) => {
  const chars = Array.from(path);
  let reachable = chars.map(() => false);
  reachable.unshift(true);
  for (const token of tokens) {
    const next = reachable.map(() => false);
    if (token.kind === "star") {
      next[0] = reachable[0] === true;
      for (let i = 1; i <= chars.length; i++)
        next[i] = reachable[i] === true || next[i - 1] === true;
    } else {
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        next[i + 1] = reachable[i] === true && char !== undefined && token.matches(char);
      }
    }
    reachable = next;
  }
  return reachable[chars.length] === true;
};
