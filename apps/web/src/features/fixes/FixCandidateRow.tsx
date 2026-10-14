import type { FixCandidate } from "./fixCandidates";

/** One comment in "Send to agent", with its checkbox. */
export function FixCandidateRow({
  candidate,
  checked,
  disabled,
  onChange,
}: {
  candidate: FixCandidate;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-muted/50 has-disabled:cursor-not-allowed">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          aria-label={`${candidate.label} on ${candidate.where}`}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="min-w-0">
          <span className="block truncate text-muted-foreground">
            {candidate.label} · <span className="font-mono">{candidate.where}</span>
          </span>
          <span className="block text-foreground">{candidate.excerpt}</span>
        </span>
      </label>
    </li>
  );
}
