import type { AccountId, InboxLeftOut } from "@prkit/contracts";

/**
 * Says an account's inbox left out pull requests prkit couldn't read or GitHub refused, never
 * what they held, with a way to open each one GitHub's answer still names.
 */
export function InboxLeftOutNotice({
  accountId,
  items,
}: {
  accountId: AccountId;
  items: ReadonlyArray<InboxLeftOut>;
}) {
  const named = items.flatMap((item) => (item.pullRequest === null ? [] : [item.pullRequest]));
  const unread = items.some((item) => item.message === null);
  const refusals = [
    ...new Set(items.flatMap((item) => (item.message === null ? [] : [item.message]))),
  ];
  const subject =
    named.length < items.length
      ? "Some pull requests"
      : items.length === 1
        ? "1 pull request"
        : `${items.length} pull requests`;
  return (
    <div
      role="alert"
      data-inbox-left-out={accountId}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
    >
      <p className="min-w-0 flex-1 basis-64 break-words text-warning-foreground">
        {subject} couldn't be shown for {accountId}.
        {unread && " prkit couldn't read what GitHub sent."}
        {refusals.map((message) => ` GitHub said: ${message}`)}
      </p>
      {named.map((pullRequest) => (
        <a
          key={pullRequest.url}
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          className="text-warning-foreground underline underline-offset-2"
        >
          Open {pullRequest.ref.owner}/{pullRequest.ref.repo}#{pullRequest.ref.number} on GitHub
        </a>
      ))}
    </div>
  );
}
