import { Skeleton } from "~/components/ui/skeleton";

/** A chapter the agent has planned but not written: its title, faded, over a light sketch. */
export function PendingChapter({
  title,
  index,
  total,
  id,
  chapterId,
}: {
  title: string;
  index: number;
  total: number;
  id: string;
  chapterId: string;
}) {
  return (
    <section
      data-guide-chapter=""
      data-chapter-id={chapterId}
      data-pending=""
      id={id}
      tabIndex={-1}
      aria-busy="true"
      aria-label={`Chapter ${index + 1}, ${title}, being written`}
    >
      <aside data-chapter-narration="">
        <div data-chapter-narration-inner="">
          <h2 data-pending-title="">{title}</h2>
          <div data-chapter-meta="">
            <span>
              {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
            </span>
          </div>
          <div className="mt-3 space-y-2">
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      </aside>
    </section>
  );
}
