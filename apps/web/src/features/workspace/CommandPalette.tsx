import { PullRequestRef, pullRequestKey, refFromKey, type PullRequestKey } from "@prkit/contracts";
import { Dialog } from "@base-ui/react/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";
import { BookOpenTextIcon, LayersIcon, SearchIcon, SettingsIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useStartGuide, useStartStackGuides } from "~/components/review";
import { Button } from "~/components/ui/button";
import { ListSkeleton } from "~/components/ListSkeleton";
import {
  accountsQuery,
  inboxQuery,
  pullRequestDetailQuery,
  pullRequestStackQuery,
} from "~/rpc/queries";

import { PaletteBranch } from "./PaletteBranch";
import { searchPalette, type PaletteEntry } from "./paletteSearch";
import { useWorkspaceSession } from "./sessionStore";
import { useWorkspace } from "./workspaceContext";

export function CommandPalette() {
  const open = useWorkspaceSession((state) => state.paletteOpen);
  const setOpen = useWorkspaceSession((state) => state.setPaletteOpen);
  const mode = useWorkspaceSession((state) => state.paletteMode);
  const workspace = useWorkspace();
  const inbox = useQuery(inboxQuery);
  const accounts = useQuery(accountsQuery);
  const client = useQueryClient();
  const form = useForm({ defaultValues: { search: "" } });
  const input = useWatch({ control: form.control, name: "search" }).trim();
  const search = input.toLowerCase();
  const url = URL.parse(input);
  const match = url?.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  const candidate = {
    host: url?.hostname,
    owner: match?.[1],
    repo: match?.[2],
    number: Number(match?.[3]),
  };
  const pastedRef =
    url?.protocol === "https:" && Schema.is(PullRequestRef)(candidate) ? candidate : null;
  const urlAccounts =
    accounts.data?.accounts.filter(
      (account) => account.status._tag === "ready" && account.host === pastedRef?.host,
    ) ?? [];
  const showSettings = mode === "all" && "settings".includes(search);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const guide = useStartGuide();
  const activeRow = pathname.startsWith("/pr/")
    ? workspace.data?.open.find((row) => row.key === workspace.data?.activeKey)
    : undefined;
  const showGenerate =
    mode === "all" && activeRow !== undefined && "generate guide".includes(search);
  const generateActive = () => {
    if (activeRow === undefined) return;
    guide.start(activeRow.key, activeRow.accountId, true);
    setOpen(false);
    form.reset();
  };
  const stackGuides = useStartStackGuides();
  // The stack the PR view's strip already read; the palette reads nothing itself.
  const activeStack =
    activeRow === undefined
      ? undefined
      : client.getQueryData(pullRequestStackQuery(activeRow.key, activeRow.accountId).queryKey);
  const [firstOpen, ...restOpen] = (activeStack?.layers ?? [])
    .filter((layer) => layer.state === "open")
    .map((layer) => layer.number);
  const showStack =
    mode === "all" &&
    firstOpen !== undefined &&
    "generate guides for the whole stack".includes(search);
  const generateStack = () => {
    if (activeRow === undefined || firstOpen === undefined) return;
    stackGuides.start({
      key: activeRow.key,
      accountId: activeRow.accountId,
      layers: [firstOpen, ...restOpen],
      regenerate: false,
    });
    setOpen(false);
    form.reset();
  };
  const entries = new Map<PullRequestKey, PaletteEntry>(
    (inbox.data?.entries ?? []).map((entry) => [
      pullRequestKey(entry.ref),
      {
        key: pullRequestKey(entry.ref),
        accountId: entry.accountId,
        title: entry.title,
        ref: entry.ref,
        opened: false,
        headBranch: entry.headBranch,
        baseBranch: entry.baseBranch,
        author: entry.author?.login ?? null,
      },
    ]),
  );
  for (const row of workspace.data?.open ?? []) {
    const ref = refFromKey(row.key);
    if (!ref) continue;
    const detail = client.getQueryData(pullRequestDetailQuery(row.key, row.accountId).queryKey);
    const existing = entries.get(row.key);
    const listed = existing?.accountId === row.accountId ? existing : null;
    entries.set(row.key, {
      key: row.key,
      accountId: row.accountId,
      title: detail?.title ?? listed?.title ?? "Pull request",
      ref,
      opened: true,
      headBranch: detail?.headBranch ?? listed?.headBranch ?? null,
      baseBranch: detail?.baseBranch ?? listed?.baseBranch ?? null,
      author: detail ? (detail.author?.login ?? null) : (listed?.author ?? null),
    });
  }
  const results = searchPalette([...entries.values()], input).slice(0, 60);
  const choose = (entry: (typeof results)[number]) => {
    workspace.open(entry.key, entry.accountId);
    setOpen(false);
    form.reset();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        setOpen(open);
        if (!open) form.reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-background/70" />
        <Dialog.Popup
          className="fixed top-[15vh] left-1/2 z-50 flex max-h-[65vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const nodes = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-command-result]"),
            );
            const index = nodes.findIndex((node) => node === document.activeElement);
            const target =
              index < 0
                ? nodes[0]
                : nodes[
                    Math.max(
                      0,
                      Math.min(nodes.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                    )
                  ];
            target?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Find a pull request</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search open pull requests and your inbox by title, repository, number, branch or author.
          </Dialog.Description>
          <form
            onSubmit={form.handleSubmit(() => {
              const first = results[0];
              if (showGenerate && search !== "") generateActive();
              else if (showStack && search !== "") generateStack();
              else if (pastedRef) {
                const account = urlAccounts.length === 1 ? urlAccounts[0] : undefined;
                if (account) {
                  workspace.open(pullRequestKey(pastedRef), account.id);
                  setOpen(false);
                  form.reset();
                }
              } else if (first) choose(first);
              else if (showSettings) {
                workspace.openSettings();
                form.reset();
              }
            })}
            className="flex items-center gap-3 border-b border-border px-4 py-3"
          >
            <SearchIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            <input
              {...form.register("search")}
              type="search"
              autoComplete="off"
              aria-label="Find a pull request"
              placeholder="Search by title, repo, #number or branch, or paste a PR URL"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            <Dialog.Close render={<Button size="micro" variant="ghost-muted" />}>Esc</Dialog.Close>
          </form>
          <div className="overflow-y-auto p-2">
            {showGenerate && activeRow !== undefined && (
              <button
                type="button"
                data-command-result=""
                disabled={guide.pending}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                onClick={generateActive}
              >
                <BookOpenTextIcon aria-hidden="true" className="size-4" />
                <span className="min-w-0 flex-1">Generate guide</span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  #{refFromKey(activeRow.key)?.number} · default agent
                </span>
              </button>
            )}
            {showStack && activeStack != null && (
              <button
                type="button"
                data-command-result=""
                disabled={stackGuides.pending}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                onClick={generateStack}
              >
                <LayersIcon aria-hidden="true" className="size-4" />
                <span className="min-w-0 flex-1">Generate guides for the whole stack</span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {1 + restOpen.length} PR{restOpen.length === 0 ? "" : "s"} · default agent
                </span>
              </button>
            )}
            {showSettings && (
              <button
                type="button"
                data-command-result=""
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                onClick={() => {
                  workspace.openSettings();
                  setOpen(false);
                  form.reset();
                }}
              >
                <SettingsIcon aria-hidden="true" className="size-4" />
                Settings
              </button>
            )}
            {pastedRef && (
              <div className="space-y-2 p-3">
                <p className="text-sm">
                  Open {pastedRef.owner}/{pastedRef.repo} #{pastedRef.number}
                </p>
                <p className="text-xs text-muted-foreground">
                  Choose the GitHub account to read this pull request.
                </p>
                {accounts.isPending && <ListSkeleton label="Loading GitHub accounts" rows={2} />}
                {accounts.isError && (
                  <div role="alert">
                    <p>{accounts.error.message}</p>
                    <Button size="sm" variant="outline" onClick={() => void accounts.refetch()}>
                      Retry
                    </Button>
                  </div>
                )}
                {urlAccounts.map((account) => (
                  <button
                    type="button"
                    data-command-result=""
                    key={account.id}
                    className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                    onClick={() => {
                      workspace.open(pullRequestKey(pastedRef), account.id);
                      setOpen(false);
                      form.reset();
                    }}
                  >
                    Open through {account.id}
                  </button>
                ))}
                {!accounts.isPending && !accounts.isError && urlAccounts.length === 0 && (
                  <p role="status">
                    No ready GitHub account for {pastedRef.host}. Open Settings to check your
                    accounts.
                  </p>
                )}
              </div>
            )}
            {input.includes("://") && !pastedRef && (
              <p role="status" className="p-3 text-sm">
                Paste an HTTPS pull request URL like https://github.com/owner/repo/pull/123.
              </p>
            )}
            {workspace.pending || inbox.isPending ? (
              <ListSkeleton label="Loading pull requests" rows={3} />
            ) : null}
            {inbox.isError && (
              <div role="alert" className="space-y-2 p-3 text-xs text-error-foreground">
                <p>{inbox.error.message}</p>
                <Button size="sm" variant="outline" onClick={() => void inbox.refetch()}>
                  Retry
                </Button>
              </div>
            )}
            {results.length === 0 &&
              !inbox.isPending &&
              !pastedRef &&
              !showSettings &&
              !showGenerate && (
                <p role="status" className="p-4 text-center text-sm text-muted-foreground">
                  No matching pull requests
                </p>
              )}
            {results.map((entry) => (
              <button
                type="button"
                data-command-result=""
                key={entry.key}
                onClick={() => choose(entry)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{entry.title}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="max-w-3/5 shrink-0 truncate">
                      {entry.ref.owner}/{entry.ref.repo} #{entry.ref.number}
                    </span>
                    {entry.headBranch && <PaletteBranch name={entry.headBranch} />}
                  </span>
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {entry.opened ? "Open" : "Inbox"}
                </span>
              </button>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
