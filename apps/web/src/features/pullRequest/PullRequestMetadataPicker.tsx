import { Popover } from "@base-ui/react/popover";
import type { PullRequestDetail } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { Controller, useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSearchInput,
} from "~/components/ui/combobox";
import { Skeleton } from "~/components/ui/skeleton";
import { UserAvatar } from "~/components/UserAvatar";
import { pullRequestCandidatesQuery } from "~/rpc/queries";
import { usePullRequestActions } from "./actionContext";

interface Option {
  readonly key: string;
  readonly label: string;
  readonly avatar: string | null;
}

export function PullRequestMetadataPicker({
  detail,
  kind,
}: {
  detail: PullRequestDetail;
  kind: "labels" | "reviewers";
}) {
  const candidates = useQuery(pullRequestCandidatesQuery(detail.key, detail.accountId));
  const actions = usePullRequestActions();
  const form = useForm<{ search: string; selected: string[] }>({
    defaultValues: {
      search: "",
      selected: kind === "labels" ? detail.labels.map((label) => label.name) : [],
    },
  });
  const search = useWatch({ control: form.control, name: "search" });
  const needle = search.toLocaleLowerCase();
  const selected = useWatch({ control: form.control, name: "selected" });
  const options: ReadonlyArray<Option> =
    kind === "labels"
      ? (candidates.data?.labels ?? []).map((label) => ({
          key: label.name,
          label: label.name,
          avatar: null,
        }))
      : [
          ...(candidates.data?.reviewers ?? []).map((user) => ({
            key: `user:${user.login}`,
            label: user.login,
            avatar: user.avatarUrl,
          })),
          ...(candidates.data?.teams ?? []).map((team) => ({
            key: `team:${team.slug}`,
            label: team.name,
            avatar: null,
          })),
        ];
  const visible = options.filter((option) => option.label.toLocaleLowerCase().includes(needle));
  const submit = form.handleSubmit((values) =>
    kind === "labels"
      ? actions.run({ kind, labels: values.selected })
      : actions.run({
          kind,
          reviewers: values.selected.flatMap((value) =>
            value.startsWith("user:") ? [value.slice(5)] : [],
          ),
          teams: values.selected.flatMap((value) =>
            value.startsWith("team:") ? [value.slice(5)] : [],
          ),
          requested: true,
        }),
  );
  return (
    <form onSubmit={submit} className="space-y-3">
      <Popover.Title className="text-sm font-semibold">
        {kind === "labels" ? "Set labels" : "Request reviewers"}
      </Popover.Title>
      <Popover.Description className="text-xs text-muted-foreground">
        {kind === "labels"
          ? "Choose the repository labels for this pull request."
          : "Choose people or teams with repository access. GitHub rejects review requests to the pull request author."}
      </Popover.Description>
      {candidates.isPending ? (
        <div aria-busy="true" aria-label="Loading candidates" className="space-y-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : candidates.error ? (
        <div role="alert" className="space-y-2 text-xs">
          <p>{candidates.error.message}</p>
          <Button size="sm" variant="outline" onClick={() => void candidates.refetch()}>
            Retry
          </Button>
        </div>
      ) : options.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {kind === "labels" ? "No repository labels" : "No reviewer candidates"}
        </p>
      ) : (
        <Controller
          control={form.control}
          name="selected"
          render={({ field }) => (
            <div className="rounded-md border border-border/60">
              <Combobox
                inline
                open
                multiple
                autoHighlight
                items={options}
                filteredItems={visible}
                filter={null}
                value={options.filter((option) => field.value.includes(option.key))}
                inputValue={search}
                onInputValueChange={(next, details) => {
                  if (details.reason !== "item-press") form.setValue("search", next);
                }}
                itemToStringLabel={(option: Option) => option.label}
                isItemEqualToValue={(option: Option, other: Option) => option.key === other.key}
                onValueChange={(next: Option[]) => field.onChange(next.map((option) => option.key))}
                disabled={actions.pending}
              >
                <ComboboxSearchInput
                  aria-label={kind === "labels" ? "Search labels" : "Search reviewers"}
                  placeholder={kind === "labels" ? "Search labels" : "Search reviewers"}
                />
                <ComboboxList className="max-h-56">
                  {(option: Option) => (
                    <ComboboxItem key={option.key} value={option}>
                      {kind === "reviewers" && (
                        <UserAvatar login={option.label} url={option.avatar} />
                      )}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.label === detail.author?.login && kind === "reviewers" && (
                        <span className="shrink-0 text-2xs text-muted-foreground">Author</span>
                      )}
                    </ComboboxItem>
                  )}
                </ComboboxList>
                <ComboboxEmpty>No matches</ComboboxEmpty>
              </Combobox>
            </div>
          )}
        />
      )}
      {actions.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {actions.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={actions.pending} onClick={actions.dismiss}>
          Cancel
        </Button>
        {kind === "reviewers" && (
          <Button
            size="sm"
            variant="outline"
            disabled={actions.pending || selected.length === 0}
            onClick={() => {
              const selected = form.getValues("selected");
              void actions.run({
                kind,
                reviewers: selected.flatMap((value) =>
                  value.startsWith("user:") ? [value.slice(5)] : [],
                ),
                teams: selected.flatMap((value) =>
                  value.startsWith("team:") ? [value.slice(5)] : [],
                ),
                requested: false,
              });
            }}
          >
            Remove requests
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={
            actions.pending || !candidates.data || (kind === "reviewers" && selected.length === 0)
          }
        >
          {actions.pending
            ? "Saving..."
            : actions.error
              ? "Retry"
              : kind === "labels"
                ? "Save labels"
                : "Request review"}
        </Button>
      </div>
    </form>
  );
}
