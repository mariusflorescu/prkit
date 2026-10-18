"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon, MinusIcon } from "lucide-react";

const checkboxVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[calc(var(--radius-sm)-2px)] border border-input bg-background text-primary-foreground outline-none transition-[background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-64 motion-reduce:transition-none",
  {
    defaultVariants: { size: "default" },
    variants: {
      size: {
        default: "size-4 [&_svg]:size-3",
        sm: "size-3.5 [&_svg]:size-2.5",
      },
    },
  },
);

type CheckboxProps = Omit<CheckboxPrimitive.Root.Props, "className" | "render"> &
  VariantProps<typeof checkboxVariants>;

function Checkbox({ size, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root className={checkboxVariants({ size })} data-slot="checkbox" {...props}>
      <CheckboxPrimitive.Indicator
        className="flex"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {state.indeterminate ? <MinusIcon strokeWidth={3} /> : <CheckIcon strokeWidth={3} />}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
