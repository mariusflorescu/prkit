import type { RiskLevel } from "@prkit/contracts";

import { RISK_LEVELS } from "./riskLevels";

/**
 * How carefully to read a chapter, in a word and a three-dot meter, so neither the color
 * nor a kind tag in the same colors can be mistaken for the level.
 */
export function RiskTag({ level }: { level: RiskLevel | "not-reviewed" }) {
  const { label, meaning } = RISK_LEVELS[level];
  return (
    <span data-risk-tag="" data-risk={level} title={meaning}>
      {level !== "not-reviewed" && (
        <span data-risk-meter="" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      )}
      <span className="sr-only">Risk: </span>
      {label}
    </span>
  );
}
