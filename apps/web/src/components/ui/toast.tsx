import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";

import { ToastViewport } from "./ToastViewport";

export const toastManager = Toast.createToastManager();

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <ToastViewport />
    </Toast.Provider>
  );
}
