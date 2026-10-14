import { Dialog } from "@base-ui/react/dialog";

import { Button } from "~/components/ui/button";

import { ReleaseNotesList } from "./ReleaseNotesList";
import { useWhatsNewDialog } from "./whatsNewStore";

/** The notes of a downloaded or just-installed update, opened from its toast. */
export function WhatsNewDialog() {
  const content = useWhatsNewDialog((store) => store.content);
  const close = useWhatsNewDialog((store) => store.close);
  return (
    <Dialog.Root
      open={content !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-background/70 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup className="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-xl outline-none transition-[scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
            <Dialog.Title className="text-sm font-medium">{content?.title}</Dialog.Title>
            <Dialog.Close render={<Button size="micro" variant="ghost-muted" />}>
              Close
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            What changed in this version of prkit.
          </Dialog.Description>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {content !== null && (
              <ReleaseNotesList notes={content.notes} releasesUrl={content.releasesUrl} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
