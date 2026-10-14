import { Link } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";

import { BrandMark } from "~/components/BrandMark";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";

export function InboxEmpty({
  filtered,
  noAccounts,
  clear,
}: {
  filtered: boolean;
  noAccounts: boolean;
  clear: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        {filtered ? (
          <EmptyMedia variant="icon">
            <SearchIcon />
          </EmptyMedia>
        ) : (
          <EmptyMedia>
            <BrandMark className="size-12 text-foreground" />
          </EmptyMedia>
        )}
        <EmptyTitle role="heading" aria-level={2}>
          {filtered
            ? "No matching pull requests"
            : noAccounts
              ? "Connect your GitHub accounts"
              : "You're all caught up"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Try a different search, account or repository."
            : noAccounts
              ? "Run gh auth login, then refresh your accounts in Settings."
              : "No open pull requests need you across your GitHub accounts."}
        </EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <Button variant="outline" onClick={clear}>
          Clear filters
        </Button>
      ) : noAccounts ? (
        <Button variant="outline" render={<Link to="/settings/accounts" />}>
          Open Settings
        </Button>
      ) : null}
    </Empty>
  );
}
