import "react";

declare module "react" {
  interface CSSProperties {
    /** A label's color, which LabelChip tints itself with. */
    "--label"?: string;
  }
}
