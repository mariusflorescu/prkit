/** A tab in the title bar: the active one is cut from the workspace panel's material, the rest sit plain on the frame. */
export const tabSurface = (active: boolean) =>
  active
    ? "bg-(--panel) text-foreground shadow-(--panel-edge)"
    : "text-muted-foreground hover:bg-accent hover:text-foreground";
