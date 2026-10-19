const PRERELEASE_PART = /^\d+$/;

/** Semver order of two versions, build metadata ignored; 0 when either isn't one. */
export const compareVersions = (left: string, right: string) => {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return match === null
      ? undefined
      : {
          core: [Number(match[1]), Number(match[2]), Number(match[3])],
          pre: match[4] === undefined ? [] : match[4].split("."),
        };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return 0;
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  // A release ranks above its prereleases.
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length);
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index] ?? "";
    const y = b.pre[index] ?? "";
    if (x === y) continue;
    const xNumeric = PRERELEASE_PART.test(x);
    const yNumeric = PRERELEASE_PART.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.pre.length - b.pre.length);
};
