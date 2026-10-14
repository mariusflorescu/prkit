import type { GuideRepository } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { guideScopeQuery } from "~/rpc/queries";

import { LoadProblem } from "./LoadProblem";
import { ScopeEditors } from "./ScopeEditors";
import { ScopeEditorsSkeleton } from "./ScopeEditorsSkeleton";

/** One repository's own settings, on top of Global. */
export function RepositoryScopePanel({ repository }: { repository: GuideRepository }) {
  const scope = { _tag: "repository", repositoryId: repository.id } as const;
  const global = useQuery(guideScopeQuery({ _tag: "global" }));
  const own = useQuery(guideScopeQuery(scope));
  const name = `${repository.owner}/${repository.name}`;
  if (global.isPending || own.isPending)
    return <ScopeEditorsSkeleton label={`Loading guide settings for ${name}`} />;
  if (global.isError || own.isError)
    return (
      <LoadProblem
        title={`Couldn't load guide settings for ${name}`}
        message={(global.error ?? own.error)?.message ?? ""}
        retry={() => {
          void global.refetch();
          void own.refetch();
        }}
      />
    );
  return (
    <ScopeEditors
      key={repository.id}
      scope={scope}
      scopeLabel="Repository"
      config={own.data}
      above={{ global: global.data, repository: null, pullRequest: null }}
      onReload={() => {
        void global.refetch();
        void own.refetch();
      }}
    />
  );
}
