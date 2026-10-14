import type { DiffFile } from "@prkit/contracts";

const generatedNames = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const generatedDirectories = new Set(["__snapshots__", "__generated__", "dist", "build", "vendor"]);
const testDirectories = new Set(["__tests__", "tests", "test"]);
const moduleExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function fileTier(path: string) {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (
    generatedNames.has(name) ||
    name.endsWith(".snap") ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    /\.generated\./.test(name) ||
    segments.slice(0, -1).some((segment) => generatedDirectories.has(segment))
  )
    return "generated";
  if (
    /\.(?:test|spec)\./.test(name) ||
    segments.slice(0, -1).some((segment) => testDirectories.has(segment))
  )
    return "test";
  return "source";
}

function stripExtension(path: string) {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
}

const baseName = (path: string) => stripExtension(path.split("/").at(-1) ?? "");

function resolveRelative(path: string, specifier: string) {
  const segments = path.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

function importedPaths(
  file: DiffFile,
  byModule: ReadonlyMap<string, string>,
  byName: ReadonlyMap<string, string>,
) {
  const imports = new Set<string>();
  if (file.patch._tag !== "text") return imports;
  for (const line of file.patch.patch.split("\n")) {
    if (!/^[ +-]/.test(line)) continue;
    for (const match of line
      .slice(1)
      .matchAll(/(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      const path = specifier.startsWith(".") ? resolveRelative(file.path, specifier) : specifier;
      const extension = moduleExtensions.find((candidate) => path.endsWith(candidate));
      const resolved = extension === undefined ? path : path.slice(0, -extension.length);
      const target =
        byModule.get(resolved) ??
        byModule.get(`${resolved}/index`) ??
        byName.get(baseName(resolved));
      if (target !== undefined && target !== file.path) imports.add(target);
    }
  }
  return imports;
}

export function orderDiffFiles(files: ReadonlyArray<DiffFile>) {
  const source = files
    .filter((file) => fileTier(file.path) === "source")
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const byModule = new Map<string, string>();
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const file of source) {
    byModule.set(stripExtension(file.path), file.path);
    const name = baseName(file.path);
    if (byName.has(name)) ambiguous.add(name);
    byName.set(name, file.path);
  }
  for (const name of ambiguous) byName.delete(name);
  const imports = new Map(source.map((file) => [file.path, importedPaths(file, byModule, byName)]));
  const remaining = new Set(source.map((file) => file.path));
  const ordered: DiffFile[] = [];
  while (remaining.size > 0) {
    const candidates = source.filter((file) => remaining.has(file.path));
    const next =
      candidates.find((file) =>
        [...(imports.get(file.path) ?? [])].every((dependency) => !remaining.has(dependency)),
      ) ?? candidates[0];
    if (next === undefined) break;
    remaining.delete(next.path);
    ordered.push(next);
  }
  const positions = new Map<string, number>();
  ordered.forEach((file, index) => {
    const name = baseName(file.path);
    if (!positions.has(name)) positions.set(name, index);
  });
  const testedName = (path: string) =>
    (path.split("/").at(-1) ?? "").replace(/\.(?:test|spec)\..*$/, "").replace(/\.[^.]+$/, "");
  const tests = files
    .filter((file) => fileTier(file.path) === "test")
    .toSorted(
      (left, right) =>
        (positions.get(testedName(left.path)) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(testedName(right.path)) ?? Number.MAX_SAFE_INTEGER) ||
        left.path.localeCompare(right.path),
    );
  const generated = files
    .filter((file) => fileTier(file.path) === "generated")
    .toSorted((left, right) => left.path.localeCompare(right.path));
  return [...ordered, ...tests, ...generated];
}
