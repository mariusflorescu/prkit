import type { GuideRepository } from "@prkit/contracts";
import { useState } from "react";

import { RepositoryFixPanel } from "~/features/fixes/RepositoryFixPanel";

import { RepositoryPicker } from "./RepositoryPicker";
import { RepositoryScopePanel } from "./RepositoryScopePanel";

/** Settings for one repository's guides, kept by GitHub's id so a rename keeps them. */
export function RepositoryGuideConfig() {
  const [selected, setSelected] = useState<GuideRepository | null>(null);
  return (
    <section
      aria-labelledby="guide-config-repository-title"
      className="mt-8 space-y-4 border-t border-border/60 pt-5"
    >
      <div>
        <h3 id="guide-config-repository-title" className="text-sm font-medium">
          For one repository
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          On top of Global for one repository: add its own rules, areas and guidance, and switch
          inherited ones on or off.
        </p>
      </div>
      <RepositoryPicker selected={selected} onSelect={setSelected} />
      {selected !== null && <RepositoryScopePanel repository={selected} />}
      {selected !== null && <RepositoryFixPanel repository={selected} />}
    </section>
  );
}
