import {
  type AgentModel,
  type ModelOptionSelection,
  modelOptionsLabel,
  resolveModelOptions,
  withModelOption,
} from "@prkit/contracts";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { Fragment } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";

import { ComposerControl, type ComposerControlSize } from "./ComposerControl";

/** The settings the chosen model advertises (effort, fast mode, service tier), rendered from its descriptors. */
export function ModelTraitsPicker({
  model,
  options,
  onChange,
  disabled = false,
  size = "sm",
}: {
  model: AgentModel;
  options: ReadonlyArray<ModelOptionSelection>;
  onChange: (options: ReadonlyArray<ModelOptionSelection>) => void;
  disabled?: boolean;
  size?: ComposerControlSize;
}) {
  if (model.options.length === 0) return null;
  const label = modelOptionsLabel(model.options, options);
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={<ComposerControl size={size} aria-label={`${model.name} settings: ${label}`} />}
      >
        <BrainIcon
          aria-hidden="true"
          className={size === "xs" ? "size-3" : "size-4 text-muted-foreground"}
        />
        <span className="truncate">{label}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className={size === "xs" ? "size-3 opacity-50" : "size-3.5 opacity-60"}
        />
      </MenuTrigger>
      <MenuPopup className="w-60">
        {resolveModelOptions(model.options, options).map((resolved, index) => (
          <Fragment key={resolved.descriptor.id}>
            {index > 0 && <MenuSeparator />}
            <MenuGroup>
              <MenuGroupLabel>{resolved.descriptor.label}</MenuGroupLabel>
              <MenuRadioGroup
                value={resolved.type === "select" ? resolved.value : resolved.value ? "on" : "off"}
                onValueChange={(next) =>
                  onChange(
                    withModelOption(options, {
                      id: resolved.descriptor.id,
                      value: resolved.type === "select" ? String(next) : next === "on",
                    }),
                  )
                }
              >
                {resolved.type === "select"
                  ? resolved.descriptor.options.map((choice) => (
                      <MenuRadioItem
                        key={choice.id}
                        value={choice.id}
                        closeOnClick
                        title={choice.description}
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0">{choice.label}</span>
                          {choice.isDefault === true && (
                            <span className="shrink-0 text-2xs text-muted-foreground">Default</span>
                          )}
                          {choice.description !== undefined && (
                            <span className="truncate text-2xs text-muted-foreground">
                              {choice.description}
                            </span>
                          )}
                        </span>
                      </MenuRadioItem>
                    ))
                  : (["on", "off"] as const).map((choice) => (
                      <MenuRadioItem key={choice} value={choice} closeOnClick>
                        {choice === "on" ? "On" : "Off"}
                      </MenuRadioItem>
                    ))}
              </MenuRadioGroup>
            </MenuGroup>
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
}
