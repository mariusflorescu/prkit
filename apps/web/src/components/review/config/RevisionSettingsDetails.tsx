import { type AttemptConfig, SCOPE_LABELS } from "@prkit/contracts";

/** Exactly the settings a revision's attempt froze, in the order they applied. */
export function RevisionSettingsDetails({ config }: { config: AttemptConfig }) {
  return (
    <div
      role="group"
      aria-label="Settings this revision was written with"
      className="max-h-[70vh] space-y-4 overflow-y-auto p-4 text-xs"
    >
      <p className="text-muted-foreground">
        The settings this revision was written with, frozen when it started.
        {config.repository === null
          ? ""
          : ` Repository: ${config.repository.owner}/${config.repository.name}.`}
      </p>
      <section aria-label="Guidance" className="space-y-1.5">
        <h4 className="font-medium">Guidance</h4>
        {config.guidance.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          config.guidance.map((block) => (
            <div key={block.scope} className="rounded-md border border-border/60 px-2.5 py-1.5">
              <p className="text-[11px] text-muted-foreground">
                {SCOPE_LABELS[block.scope]}
                {block.replacedBy === null
                  ? ""
                  : ` · replaced by ${SCOPE_LABELS[block.replacedBy]}, not used`}
              </p>
              <p className="whitespace-pre-wrap">{block.text}</p>
            </div>
          ))
        )}
      </section>
      <section aria-label="Focus areas" className="space-y-1.5">
        <h4 className="font-medium">Focus areas</h4>
        {config.focusAreas.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-1">
            {config.focusAreas.map((area) => (
              <li key={area.id} className={area.active ? "" : "text-muted-foreground line-through"}>
                <span className="font-medium">{area.label}</span>: {area.question}{" "}
                <span className="text-muted-foreground">
                  ({SCOPE_LABELS[area.scope]}
                  {area.active
                    ? ""
                    : `, off at ${area.decidedBy === null ? "" : SCOPE_LABELS[area.decidedBy]}`}
                  )
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Ignore rules" className="space-y-1.5">
        <h4 className="font-medium">Ignore rules, in the order they apply</h4>
        {config.ignore.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ol className="space-y-0.5">
            {config.ignore.map((rule) => (
              <li key={rule.id} className={rule.active ? "" : "text-muted-foreground line-through"}>
                <code>{rule.pattern}</code> ({SCOPE_LABELS[rule.scope]})
                {rule.decidedBy === null
                  ? ""
                  : ` · ${rule.active ? "on" : "off"} at ${SCOPE_LABELS[rule.decidedBy]}`}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Skipped files" className="space-y-1.5">
        <h4 className="font-medium">Skipped files</h4>
        {config.skipped.length === 0 ? (
          <p className="text-muted-foreground">None: every changed file was reviewed.</p>
        ) : (
          <ul className="space-y-0.5">
            {config.skipped.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>{" "}
                <span className="text-muted-foreground">
                  +{file.additions} −{file.deletions} · skipped by{" "}
                  {file.reasons.map((reason, index) => (
                    <span key={reason.path}>
                      {index > 0 ? " and " : ""}
                      <code>{reason.pattern}</code> ({SCOPE_LABELS[reason.scope]})
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Always look closely at" className="space-y-1.5">
        <h4 className="font-medium">Always look closely at, in the order they apply</h4>
        {config.sensitive.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ol className="space-y-0.5">
            {config.sensitive.map((rule) => (
              <li key={rule.id} className={rule.active ? "" : "text-muted-foreground line-through"}>
                <code>{rule.pattern}</code> ({SCOPE_LABELS[rule.scope]})
                {rule.decidedBy === null
                  ? ""
                  : ` · ${rule.active ? "on" : "off"} at ${SCOPE_LABELS[rule.decidedBy]}`}
              </li>
            ))}
          </ol>
        )}
      </section>
      {config.dangling.length > 0 && (
        <p role="status" className="text-warning-foreground">
          {config.dangling.length === 1
            ? "One override pointed at a deleted item and did nothing."
            : `${config.dangling.length} overrides pointed at deleted items and did nothing.`}
        </p>
      )}
    </div>
  );
}
