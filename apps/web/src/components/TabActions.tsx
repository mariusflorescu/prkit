import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

const TabActionsTarget = createContext<HTMLElement | null>(null);

/** Where the open tab's own controls go: the right side of the PR view's tab row. */
export const TabActionsSlot = TabActionsTarget.Provider;

/** Whether a tab row is there to take this view's controls. */
export const useHasTabActions = () => useContext(TabActionsTarget) !== null;

/** Puts a tab's controls, such as the diff view toggles, on the tab row above it. */
export function TabActions({ children }: { children: ReactNode }) {
  const target = useContext(TabActionsTarget);
  return target === null ? null : createPortal(children, target);
}
