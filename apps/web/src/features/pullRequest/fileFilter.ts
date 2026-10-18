import type { FileReviewState } from "@prkit/contracts";

export type FileFilter = { readonly text: string; readonly toReview: boolean };

export const NO_FILE_FILTER: FileFilter = { text: "", toReview: false };

export const isFiltering = (filter: FileFilter) => filter.text.trim() !== "" || filter.toReview;

type Filterable = { readonly path: string; readonly previousPath: string | null };

/**
 * The files whose path (or the path they were renamed from) holds every word of the text,
 * in the order given. `toReview` keeps unreviewed and changed files; `unknown` is not to
 * review, as in the reviewed count. Without `stateOf` there is nothing to review by.
 */
export const filterFiles = <T extends Filterable>(
  files: ReadonlyArray<T>,
  filter: FileFilter,
  stateOf: ((file: T) => FileReviewState) | null,
): Array<T> => {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  return files.filter((file) => {
    if (words.length > 0) {
      const paths = `${file.path}\n${file.previousPath ?? ""}`.toLowerCase();
      if (!words.every((word) => paths.includes(word))) return false;
    }
    if (filter.toReview && stateOf !== null) {
      const state = stateOf(file);
      return state === "unreviewed" || state === "changed";
    }
    return true;
  });
};
