import { Popover } from "@base-ui/react/popover";
import {
  pullRequestActionLabels,
  pullRequestActionReason,
  type PullRequestDetail,
  type PullRequestMergeMethod,
} from "@prkit/contracts";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { usePullRequestActions, type ActionEditor } from "./actionContext";
import { mergeMethods, resolveMergeMethod } from "./actionPresentation";

export function PullRequestActionForm({
  detail,
  kind,
}: {
  detail: PullRequestDetail;
  kind: Exclude<ActionEditor, "edit" | "labels" | "reviewers">;
}) {
  const actions = usePullRequestActions();
  const defaultMethod = kind === "update-branch" ? "merge" : resolveMergeMethod(detail);
  const form = useForm<{
    method: PullRequestMergeMethod;
    title: string;
    body: string;
    deleteBranch: boolean;
  }>({
    defaultValues: {
      method: defaultMethod,
      title:
        defaultMethod === "rebase"
          ? detail.title
          : detail.actions.mergeMessages[defaultMethod].title,
      body: defaultMethod === "rebase" ? "" : detail.actions.mergeMessages[defaultMethod].body,
      deleteBranch: detail.actions.canDeleteBranch && detail.actions.preferences.deleteBranch,
    },
  });
  const method = useWatch({ control: form.control, name: "method" });
  useEffect(() => {
    if (method === "rebase") return;
    form.setValue("title", detail.actions.mergeMessages[method].title);
    form.setValue("body", detail.actions.mergeMessages[method].body);
  }, [method, detail.actions.mergeMessages, form]);
  const reason = pullRequestActionReason(detail, kind);
  const methodChoices = mergeMethods
    .filter(({ method: option }) => kind !== "update-branch" || option !== "squash")
    .map(({ method: option, label }) => {
      const disabled = kind !== "update-branch" && !detail.actions.mergeCapabilities[option];
      return {
        value: option,
        label:
          kind === "update-branch"
            ? option === "rebase"
              ? "Rebase onto base"
              : "Merge base into branch"
            : disabled
              ? `${label} (disabled by repository)`
              : label,
        disabled,
      };
    });
  const submit = form.handleSubmit(async (values) => {
    switch (kind) {
      case "merge":
        await actions.run({
          kind,
          method: values.method,
          title: values.title.trim(),
          body: values.body,
          expectedHeadSha: detail.headSha,
          deleteBranch: values.deleteBranch,
        });
        break;
      case "enable-auto-merge":
        await actions.run({ kind, method: values.method });
        break;
      case "update-branch":
        if (values.method !== "squash")
          await actions.run({ kind, method: values.method, expectedHeadSha: detail.headSha });
        break;
      case "approve-workflows":
        await actions.run({ kind, expectedHeadSha: detail.headSha });
        break;
      case "close":
      case "revert":
        await actions.run({ kind });
        break;
    }
  });
  return (
    <form
      data-pr-action-head={detail.headSha}
      onSubmit={submit}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}
      className="space-y-3"
    >
      <Popover.Title className="text-sm font-semibold">
        {pullRequestActionLabels[kind]}
      </Popover.Title>
      <Popover.Description className="text-xs text-muted-foreground">
        {detail.ref.owner}/{detail.ref.repo} #{detail.ref.number} through{" "}
        {detail.accountId.split("/").slice(1).join("/")}
      </Popover.Description>
      {(kind === "merge" || kind === "enable-auto-merge" || kind === "update-branch") && (
        <div className="space-y-1 text-xs">
          <span id="pr-action-method">Method</span>
          <Controller
            control={form.control}
            name="method"
            render={({ field }) => (
              <Select<PullRequestMergeMethod>
                value={field.value}
                items={methodChoices}
                disabled={actions.pending}
                onValueChange={(next) => {
                  if (next !== null) field.onChange(next);
                }}
              >
                <SelectTrigger aria-labelledby="pr-action-method" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {methodChoices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          />
        </div>
      )}
      {kind === "merge" && method !== "rebase" && (
        <>
          <label className="block space-y-1 text-xs">
            Commit title
            <input
              {...form.register("title", {
                validate: (value) => value.trim().length > 0 || "Enter a commit title.",
              })}
              aria-invalid={Boolean(form.formState.errors.title)}
              data-pr-action-input=""
              disabled={actions.pending}
            />
          </label>
          {form.formState.errors.title && (
            <p role="alert" className="text-xs text-error-foreground">
              {form.formState.errors.title.message}
            </p>
          )}
          <label className="block space-y-1 text-xs">
            Commit message
            <textarea
              {...form.register("body")}
              data-pr-action-input=""
              className="min-h-24 resize-y"
              disabled={actions.pending}
            />
          </label>
        </>
      )}
      {kind === "merge" && (
        <label
          title={
            detail.actions.canDeleteBranch
              ? undefined
              : "Branches from forks, protected branches and deleted branches cannot be deleted here."
          }
          className="flex items-center gap-2 text-xs"
        >
          <input
            type="checkbox"
            {...form.register("deleteBranch")}
            disabled={actions.pending || !detail.actions.canDeleteBranch}
          />
          Delete branch after merge
        </label>
      )}
      {kind === "close" && (
        <p className="text-xs">Close this pull request? Its branch and conversation will stay.</p>
      )}
      {kind === "revert" && (
        <p className="text-xs">
          Create a new pull request that reverses this merge. The new pull request opens in its own
          tab.
        </p>
      )}
      {kind === "approve-workflows" && (
        <p className="text-xs">
          Allow fork workflows to run for commit {detail.headSha.slice(0, 7)}. Review the fork's
          code first.
        </p>
      )}
      {reason && (
        <p role="alert" className="text-xs text-warning-foreground">
          {reason}
        </p>
      )}
      {actions.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {actions.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={actions.dismiss} disabled={actions.pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant={kind === "close" ? "destructive" : "default"}
          disabled={actions.pending || reason !== null}
        >
          {actions.pending
            ? "Working..."
            : actions.error
              ? "Retry"
              : kind === "merge"
                ? "Confirm merge"
                : kind === "close"
                  ? "Confirm close"
                  : kind === "revert"
                    ? "Create revert pull request"
                    : pullRequestActionLabels[kind]}
        </Button>
      </div>
    </form>
  );
}
