import type { ReleaseNotes } from "@prkit/contracts";
import { ExternalLinkIcon } from "lucide-react";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const pullNumber = (url: string) => /\/pull\/(\d+)$/.exec(url)?.[1];

const linkClass =
  "rounded-sm text-muted-foreground underline decoration-dotted underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * What changed, newest version first, grouped as the release body groups it. Every line is
 * plain text; the only links are the pull requests and the releases page, opened in the browser.
 */
export function ReleaseNotesList({
  notes,
  releasesUrl,
}: {
  notes: ReleaseNotes;
  releasesUrl: string | null;
}) {
  if (notes.versions.length === 0)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        This release has no notes.
        {releasesUrl !== null && (
          <>
            {" "}
            <a href={releasesUrl} target="_blank" rel="noreferrer" className={linkClass}>
              See the releases on GitHub
            </a>
          </>
        )}
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {notes.versions.map((version) => (
        <section key={version.version} aria-label={`Changes in ${version.version}`}>
          <h3 className="font-mono text-xs font-medium text-foreground tabular-nums">
            {version.version}
          </h3>
          {version.summary !== null && (
            <p className="mt-1 text-xs text-muted-foreground">{version.summary}</p>
          )}
          {version.groups.map((group) => (
            <div key={group.title} className="mt-2">
              <h4 className="text-[11px] font-medium text-muted-foreground">{group.title}</h4>
              <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-xs leading-5 text-popover-foreground">
                {group.items.map((item) => (
                  <li key={`${item.text}:${item.prUrl ?? ""}`} className="break-words">
                    {item.text}
                    {item.prUrl !== undefined && (
                      <>
                        {" "}
                        <a href={item.prUrl} target="_blank" rel="noreferrer" className={linkClass}>
                          #{pullNumber(item.prUrl) ?? "PR"}
                        </a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {version.omittedItems > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              And {plural(version.omittedItems, "more change")} in the release.
            </p>
          )}
        </section>
      ))}
      {(notes.omittedVersions > 0 || releasesUrl !== null) && (
        <p className="text-xs text-muted-foreground">
          {notes.omittedVersions > 0 && "Older releases aren't shown. "}
          {releasesUrl !== null && (
            <a
              href={releasesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm text-muted-foreground underline decoration-dotted underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              All releases on GitHub
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          )}
        </p>
      )}
    </div>
  );
}
