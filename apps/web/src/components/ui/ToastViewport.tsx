import { Toast } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";

export function ToastViewport() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-[calc(var(--panel-inset)+1rem)] bottom-[calc(var(--panel-inset)+1rem)] z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className="relative rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
          >
            <Toast.Content>
              <Toast.Title className="pr-6 font-medium text-sm" />
              <Toast.Description className="mt-1 text-xs text-muted-foreground" />
              <Toast.Action className="mt-2 cursor-pointer rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              <Toast.Close
                aria-label="Dismiss notification"
                className="absolute top-2 right-2 rounded-md p-2 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-4" />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
