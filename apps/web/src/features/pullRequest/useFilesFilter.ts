import type { PullRequestKey } from "@prkit/contracts";
import { useCallback } from "react";

import { useWorkspaceSession } from "~/features/workspace/sessionStore";

import { type FileFilter, NO_FILE_FILTER } from "./fileFilter";

/** The Files tree filter of one PR, kept for the session so a tab switch doesn't lose it. */
export function useFilesFilter(key: PullRequestKey) {
  const filter = useWorkspaceSession((state) => state.views[key]?.filesFilter ?? NO_FILE_FILTER);
  const remember = useWorkspaceSession((state) => state.rememberFilesFilter);
  const setFilter = useCallback((next: FileFilter) => remember(key, next), [key, remember]);
  return [filter, setFilter] as const;
}
