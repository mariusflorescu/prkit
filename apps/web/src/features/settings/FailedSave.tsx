import type { UseMutationResult } from "@tanstack/react-query";

import { SettingsAlert } from "./SettingsAlert";

const ownMessage = (error: Error) => error.message;

/**
 * A setting's save that failed, in prkit's words, with a Retry that sends the same change again.
 * It goes below the controls that saved, so none of them moves under the pointer when it shows.
 */
export function FailedSave<TData, TVariables, TContext>({
  save,
  describe = ownMessage,
}: {
  save: UseMutationResult<TData, Error, TVariables, TContext>;
  describe?: (error: Error) => string;
}) {
  if (save.error === null) return null;
  return (
    <SettingsAlert
      message={describe(save.error)}
      retry={() => {
        const last = save.variables;
        save.reset();
        if (last !== undefined) save.mutate(last);
      }}
    />
  );
}
