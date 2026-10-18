import { type NormalizedPseudocodePair, pseudocodeRows } from "@prkit/contracts";

import { PseudocodeSide } from "./PseudocodeSide";

/** How a chapter's logic worked before and how it works now, changed lines marked like a diff. */
export function PseudocodePair({ pair }: { pair: NormalizedPseudocodePair }) {
  const rows = pseudocodeRows(pair);
  return (
    <div data-pseudocode-container="">
      <div data-pseudocode-pair="">
        <PseudocodeSide side="before" label="Before" lines={rows.map((row) => row.before)} />
        <PseudocodeSide side="after" label="After" lines={rows.map((row) => row.after)} />
      </div>
    </div>
  );
}
