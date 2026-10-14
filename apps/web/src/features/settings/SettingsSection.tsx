import { useId, type ReactNode } from "react";

/** The heading, description and optional action every Settings section starts with. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-sm font-medium text-foreground/80">
            {title}
          </h2>
          {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
