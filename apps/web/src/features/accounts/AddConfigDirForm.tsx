import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { addConfigDir } from "~/rpc/client";
import { accountsQuery, inboxQuery } from "~/rpc/queries";

export function AddConfigDirForm() {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm({ defaultValues: { path: "" } });
  const add = useMutation({
    mutationFn: addConfigDir,
    onSuccess: (result) => {
      queryClient.setQueryData(accountsQuery.queryKey, result);
      void queryClient.invalidateQueries({ queryKey: inboxQuery.queryKey });
      reset();
      toastManager.add({
        title: "GitHub directory added",
        description: "Its accounts are now included in your inbox.",
        type: "success",
      });
    },
    onError: (error) =>
      setError("path", { type: "server", message: error.message }, { shouldFocus: true }),
  });
  return (
    <form
      className="space-y-3"
      onSubmit={handleSubmit(({ path }) => add.mutate(path.trim()))}
      noValidate
    >
      <label htmlFor="config-dir" className="block font-medium text-sm">
        Add gh config directory
      </label>
      <p className="text-xs text-muted-foreground">
        Default gh directories are found automatically. Add a directory stored elsewhere.
      </p>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <input
            id="config-dir"
            type="text"
            placeholder="~/work/github-config"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.path)}
            aria-describedby={errors.path ? "config-dir-error" : undefined}
            disabled={add.isPending}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error sm:text-sm"
            {...register("path", {
              required: "Enter a gh config directory.",
              validate: (value) =>
                value.trim().startsWith("/") ||
                value.trim().startsWith("~/") ||
                "Use an absolute path or a path starting with ~/.",
            })}
          />
          {errors.path && (
            <p id="config-dir-error" role="alert" className="mt-2 text-xs text-error-foreground">
              {errors.path.message}
            </p>
          )}
        </div>
        <Button type="submit" variant="outline" disabled={add.isPending}>
          {add.isPending ? "Adding..." : "Add directory"}
        </Button>
      </div>
    </form>
  );
}
