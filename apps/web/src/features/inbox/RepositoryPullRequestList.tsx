import type { RepositoryFilter } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { FreshnessNotice } from "~/features/github/FreshnessNotice";
import { repositoryPullRequestsQuery } from "~/rpc/queries";

import { InboxLeftOutNotice } from "./InboxLeftOutNotice";
import { updatedClock } from "./inboxPresentation";
import { InboxRow } from "./InboxRow";

/** A repository's open pull requests, in the Inbox's row style, read through one account. */
export function RepositoryPullRequestList({ repository }: { repository: RepositoryFilter }) {
  const name = `${repository.owner}/${repository.name}`;
  const [reader] = repository.accountIds;
  const query = useQuery(
    repositoryPullRequestsQuery({
      accountId: reader,
      host: repository.host,
      owner: repository.owner,
      name: repository.name,
    }),
  );
  if (query.isPending)
    return <ListSkeleton label={`Loading open pull requests in ${name}`} rows={4} />;
  if (query.isError)
    return (
      <ListError
        title={`Couldn't list the open pull requests in ${name}`}
        message={query.error.message}
        retry={() => void query.refetch()}
      />
    );
  const { entries, leftOut, total, freshness } = query.data;
  return (
    <section aria-label={`Open in ${name}`} className="mb-6">
      <h2 className="flex items-center gap-2 px-3 py-3 font-medium text-xs text-muted-foreground">
        Open in {name}
        <span className="text-2xs tabular-nums">{total}</span>
        <span aria-hidden className="ml-1 h-px flex-1 bg-border/60" />
      </h2>
      {freshness.problem !== null && (
        <div className="px-3 pb-3">
          <FreshnessNotice
            problem={freshness.problem}
            accountId={reader}
            fetchedAt={freshness.fetchedAt}
            retry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      )}
      {leftOut.length > 0 && (
        <div className="px-3 pb-3">
          <InboxLeftOutNotice accountId={reader} items={leftOut} />
        </div>
      )}
      {entries.length === 0 ? (
        leftOut.length > 0 ? null : (
          <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
            No open pull requests in {name}.
          </p>
        )
      ) : (
        <ul>
          {entries.map((entry) => (
            <InboxRow
              key={entry.ref.number}
              entry={entry}
              clock={updatedClock(entry)}
              showAccount={false}
            />
          ))}
        </ul>
      )}
      {total > entries.length && (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          The {entries.length} most recently updated of {total}.{" "}
          <a
            href={`https://${repository.host}/${name}/pulls`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            See all on GitHub
          </a>
        </p>
      )}
    </section>
  );
}
