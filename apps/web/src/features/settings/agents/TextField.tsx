import type { UseFormRegisterReturn } from "react-hook-form";

const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-base outline-none placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-error disabled:opacity-64 sm:text-sm";

/** One labelled text input with its hint and its error, for the agent forms. */
export function TextField({
  id,
  label,
  hint,
  error,
  placeholder,
  mono = false,
  disabled = false,
  field,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  field: UseFormRegisterReturn;
}) {
  const described = [
    hint === undefined ? null : `${id}-hint`,
    error === undefined ? null : `${id}-error`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={described === "" ? undefined : described}
        className={mono ? `${inputClass} font-mono` : inputClass}
        {...field}
      />
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-2xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={`${id}-error`} role="alert" className="text-xs text-error-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
