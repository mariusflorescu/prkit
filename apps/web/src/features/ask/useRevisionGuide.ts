import type { PullRequestKey } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { guideQuery } from "~/rpc/queries";

const noFiles: ReadonlySet<string> = new Set();

/** A revision's guide, and the files its chapters show, which answers about it can link to. */
export function useRevisionGuide(key: PullRequestKey, revision: number) {
  const guide = useQuery(guideQuery(key, revision)).data?.normalized;
  const files = useMemo(
    () =>
      guide === undefined
        ? noFiles
        : new Set(guide.chapters.flatMap((chapter) => chapter.files.map((file) => file.path))),
    [guide],
  );
  return { guide, files };
}
