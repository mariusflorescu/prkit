import type { CheckScript } from "@prkit/contracts";

/** The check scripts a turn may run, with their exact commands from the PR head's package.json. */
export function TurnScriptsList({ scripts }: { scripts: ReadonlyArray<CheckScript> }) {
  return (
    <div className="mt-2 text-xs text-muted-foreground">
      <p>The agent may run these scripts from the pull request's package.json:</p>
      <ul aria-label="Scripts the agent may run" className="mt-1 space-y-0.5">
        {scripts.map((script) => (
          <li key={script.name} className="flex flex-wrap gap-x-2">
            <code className="font-mono text-foreground">
              {script.name === "test" ? "npm test" : `npm run ${script.name}`}
            </code>
            <code className="font-mono break-all whitespace-pre-wrap">{script.command}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
