import { Dialog } from "@base-ui/react/dialog";
import type { AgentCatalog, AgentInstanceId } from "@prkit/contracts";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { cn } from "~/lib/utils";

import { AddAgentKindStep } from "./AddAgentKindStep";
import { AddAgentNameStep } from "./AddAgentNameStep";
import { AddAgentSetupStep } from "./AddAgentSetupStep";
import { AddAgentSignInStep } from "./AddAgentSignInStep";
import { AddCursorStep } from "./AddCursorStep";
import {
  type AddAgentValues,
  configFromWizard,
  defaultsFor,
  stepProblem,
  stepsFor,
} from "./addAgentWizard";
import { useAgentInstanceActions } from "./useAgentInstanceActions";

/**
 * Adds an agent instance in three steps: which agent, what it's called, and where it runs from.
 * Problems show once Next was refused, then follow what the user types. "Sign in with ChatGPT"
 * adds a Codex instance with prkit's own login and starts that sign-in right away; Cursor adds
 * one that installs Cursor support and signs in from its last step.
 */
export function AddAgentDialog({
  catalog,
  open,
  onOpenChange,
}: {
  catalog: AgentCatalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { create } = useAgentInstanceActions();
  const form = useForm<AddAgentValues>({ defaultValues: defaultsFor("claude", "manual") });
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<AgentInstanceId | null>(null);
  const [kind, setup, label, instanceId, accent, binaryPath, configDir] = useWatch({
    control: form.control,
    name: ["kind", "setup", "label", "instanceId", "accent", "binaryPath", "configDir"],
  });
  const values: AddAgentValues = {
    kind,
    setup,
    label,
    instanceId,
    accent,
    binaryPath,
    configDir,
  };
  const existing = new Set<string>(
    [...catalog.providers, ...catalog.damaged].map((entry) => entry.instance),
  );
  const steps = stepsFor(values.setup);
  const problem = attempted ? stepProblem(step, values, existing) : null;
  const last = step === steps.length - 1;

  const close = () => {
    onOpenChange(false);
    form.reset(defaultsFor("claude", "manual"));
    setStep(0);
    setAttempted(false);
    setCreated(null);
    create.reset();
  };
  const next = () => {
    if (stepProblem(step, values, existing) !== null) {
      setAttempted(true);
      return;
    }
    if (!last) {
      setStep(step + 1);
      return;
    }
    const config = configFromWizard(values, existing);
    create.mutate(config, {
      onSuccess: () => (values.setup === "manual" ? close() : setCreated(config.id)),
    });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !create.isPending) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-background/70 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup className="fixed top-[14vh] left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <Dialog.Title className="text-sm font-medium">Add agent</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Another setup of an agent on this Mac, with its own sign-in.
          </Dialog.Description>
          <ol aria-label="Steps" className="mt-4 flex items-center gap-2 text-xs">
            {steps.map((name, index) => (
              <li
                key={name}
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5",
                  index === step ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full border text-2xs tabular-nums",
                    index === step ? "border-foreground" : "border-border",
                  )}
                >
                  {index + 1}
                </span>
                {name}
                {index < steps.length - 1 && (
                  <span aria-hidden="true" className="text-border">
                    /
                  </span>
                )}
              </li>
            ))}
          </ol>
          <form
            noValidate
            aria-label={`Add agent: ${steps[step] ?? ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (created === null) next();
              else close();
            }}
            className="mt-4"
          >
            <fieldset disabled={create.isPending} className="min-h-56">
              {step === 0 && (
                <AddAgentKindStep
                  kind={values.kind}
                  setup={values.setup}
                  onChange={(kind, setup) => {
                    form.reset(defaultsFor(kind, setup));
                    setAttempted(false);
                  }}
                />
              )}
              {step === 1 && <AddAgentNameStep form={form} existing={existing} problem={problem} />}
              {step === 2 && values.setup === "manual" && (
                <AddAgentSetupStep form={form} problem={problem} />
              )}
              {step === 2 && values.setup === "chatgpt" && <AddAgentSignInStep created={created} />}
              {step === 2 && values.setup === "cursor" && <AddCursorStep created={created} />}
            </fieldset>
            <div className="mt-5 flex items-center justify-end gap-2">
              {created === null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost-muted"
                  disabled={create.isPending}
                  onClick={close}
                >
                  Cancel
                </Button>
              )}
              {step > 0 && created === null && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={create.isPending}
                  onClick={() => setStep(step - 1)}
                >
                  Back
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={create.isPending}
                aria-busy={create.isPending}
              >
                <ButtonLabel
                  shown={
                    created !== null
                      ? "done"
                      : !last
                        ? "next"
                        : create.isPending
                          ? "adding"
                          : values.setup !== "manual"
                            ? "signin"
                            : "add"
                  }
                  labels={{
                    done: "Done",
                    next: "Next",
                    adding: "Adding…",
                    signin: "Add and sign in",
                    add: "Add agent",
                  }}
                />
              </Button>
            </div>
            {create.error !== null && !create.isPending && (
              <p role="alert" className="mt-3 text-xs text-error-foreground">
                {create.error.message}
              </p>
            )}
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
