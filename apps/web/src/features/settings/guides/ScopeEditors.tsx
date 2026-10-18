import {
  type GuideConfigLayers,
  type GuideScope,
  resolveGuideConfig,
  type ScopeConfig,
} from "@prkit/contracts";

import { FocusAreasEditor } from "./FocusAreasEditor";
import { GuidanceEditor } from "./GuidanceEditor";
import { PathRulesEditor } from "./PathRulesEditor";

/** The four sections of one scope, with what it inherits from the scopes above it. */
export function ScopeEditors({
  scope,
  scopeLabel,
  config,
  above,
  onReload,
}: {
  scope: GuideScope;
  scopeLabel: string;
  config: ScopeConfig;
  /** The less specific scopes; null for Global. */
  above: GuideConfigLayers | null;
  onReload: () => void;
}) {
  const inherited = above === null ? null : resolveGuideConfig(above);
  return (
    <div className="space-y-6">
      <PathRulesEditor
        kind="ignore"
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.ignore}
        inherited={inherited?.ignore ?? []}
        onReload={onReload}
      />
      <PathRulesEditor
        kind="sensitive"
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.sensitive}
        inherited={inherited?.sensitive ?? []}
        onReload={onReload}
      />
      <FocusAreasEditor
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.focus}
        inherited={inherited?.focusAreas ?? []}
        onReload={onReload}
      />
      <GuidanceEditor
        scope={scope}
        scopeLabel={scopeLabel}
        section={config.guidance}
        inherited={inherited?.guidance ?? []}
        onReload={onReload}
      />
    </div>
  );
}
