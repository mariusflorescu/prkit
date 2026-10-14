import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";

/** The one terminal command that fixes a provider, with a button to copy it. */
export function FixCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
        {command}
      </code>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label={`Copy ${command}`}
        onClick={() =>
          navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () =>
              toastManager.add({
                title: "Couldn't copy the command",
                description: "Select it and copy it by hand.",
                type: "error",
              }),
          )
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
