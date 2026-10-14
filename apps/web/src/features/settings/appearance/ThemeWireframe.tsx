import { cn } from "~/lib/utils";

import type { PreviewTone } from "./themeOptions";

// Brand neutrals from assets/brand/tokens and the window frame from index.css. Fixed per tone,
// so a card shows its own theme whichever one the app is in.
const TONES = {
  light: {
    frame: "var(--frame-light)",
    canvas: "var(--prk-neutral-50)",
    bar: "var(--prk-neutral-100)",
    line: "var(--prk-neutral-200)",
    text: "var(--prk-neutral-300)",
    strong: "var(--prk-neutral-700)",
  },
  dark: {
    frame: "var(--frame-dark)",
    canvas: "var(--prk-neutral-900)",
    bar: "var(--prk-neutral-800)",
    line: "var(--prk-neutral-700)",
    text: "var(--prk-neutral-600)",
    strong: "var(--prk-neutral-100)",
  },
} as const satisfies Record<PreviewTone, Record<string, string>>;

const ROWS = [
  { dot: "var(--prk-rose-500)", title: "46%", meta: "12%" },
  { dot: "var(--prk-added)", title: "38%", meta: "14%" },
  { dot: "var(--prk-added)", title: "52%", meta: "10%" },
  { dot: "var(--prk-warning)", title: "34%", meta: "13%" },
] as const;

// A miniature of prkit: the title bar's mark and tabs on the frame, then inbox rows on the inset panel.
function WireframePane({ tone, clip }: { tone: PreviewTone; clip?: "left" | "right" }) {
  const colors = TONES[tone];
  return (
    <span
      className="absolute inset-0"
      style={
        clip === undefined
          ? undefined
          : {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
      }
    >
      <span className="absolute inset-0" style={{ backgroundColor: colors.frame }} />
      <span
        className="absolute inset-x-[2.5%] top-[16%] bottom-[3.5%] rounded-md"
        style={{ backgroundColor: colors.canvas, boxShadow: `0 0 0 1px ${colors.line}` }}
      />
      <span
        className="absolute left-[4%] top-[5%] h-[6%] w-[16%] rounded-sm"
        style={{ backgroundColor: colors.strong, opacity: 0.85 }}
      />
      <span
        className="absolute left-[23%] top-[5%] h-[6%] w-[11%] rounded-sm"
        style={{ backgroundColor: colors.text }}
      />
      <span
        className="absolute left-[37%] top-[5%] h-[6%] w-[11%] rounded-sm"
        style={{ backgroundColor: colors.text }}
      />
      {ROWS.map((row, index) => (
        <span
          key={row.title}
          className="absolute inset-x-[6%] flex items-center gap-[3%] rounded-sm px-[2%]"
          style={{
            top: `${23 + index * 18}%`,
            height: "14%",
            backgroundColor: index === 0 ? colors.bar : undefined,
            boxShadow: `inset 0 -1px 0 ${colors.line}`,
          }}
        >
          <span
            className="block aspect-square h-[34%] shrink-0 rounded-full"
            style={{ backgroundColor: row.dot }}
          />
          <span
            className="block h-[24%] rounded-sm"
            style={{ width: row.title, backgroundColor: colors.strong, opacity: 0.55 }}
          />
          <span
            className="ml-auto block h-[24%] rounded-sm"
            style={{ width: row.meta, backgroundColor: colors.text }}
          />
        </span>
      ))}
    </span>
  );
}

export function ThemeWireframe({
  tones,
  className,
}: {
  tones: ReadonlyArray<PreviewTone>;
  className?: string;
}) {
  const [first, second] = tones;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block w-full overflow-hidden rounded-lg border border-border/60",
        className,
      )}
    >
      {first !== undefined && second !== undefined ? (
        <>
          <WireframePane tone={first} clip="left" />
          <WireframePane tone={second} clip="right" />
        </>
      ) : (
        first !== undefined && <WireframePane tone={first} />
      )}
    </span>
  );
}
