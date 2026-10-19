import { useIsMutating } from "@tanstack/react-query";

import type { FormKey } from "./reviewCommentsStore";

/** The mutation key of what a form sends, so a field the diff remounted still knows it is sending. */
export const sendingKey = (form: FormKey) => ["commentForm", form] as const;

/** Whether a form's words are on their way, sent from this field or from one before its remount. */
export const useFormSending = (form: FormKey) =>
  useIsMutating({ mutationKey: sendingKey(form) }) > 0;
