import { useId } from "react";

// Smoothstep falloff: a soft core and a soft edge, so the wash never shows a band or a rim.
const FALLOFF = [1, 0.972, 0.896, 0.784, 0.648, 0.5, 0.352, 0.216, 0.104, 0.028, 0].map(
  (opacity, index, all) => ({ offset: index / (all.length - 1), opacity }),
);
// A broad blush and a smaller, deeper core, both anchored behind the traffic lights. Colors and
// strengths are the --titlebar-* tokens in index.css.
const LAYERS = [
  { name: "wash", transform: "translate(36 6) scale(320 58)" },
  { name: "core", transform: "translate(30 4) scale(130 40)" },
] as const;

/**
 * A still rose wash in the title bar's top-left corner, behind the traffic lights and the
 * mark. It fades to the bar's own background before the first tab.
 */
export function TitleBarBackdrop() {
  const id = useId();
  return (
    <div
      aria-hidden
      data-titlebar-backdrop=""
      className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-90 overflow-hidden mask-b-from-40% select-none"
    >
      <svg className="size-full" fill="none" viewBox="0 0 360 52" preserveAspectRatio="none">
        <defs>
          {LAYERS.map((layer) => (
            <radialGradient
              key={layer.name}
              id={`${id}-${layer.name}`}
              cx="0"
              cy="0"
              r="1"
              gradientTransform={layer.transform}
              gradientUnits="userSpaceOnUse"
            >
              {FALLOFF.map(({ offset, opacity }) => (
                <stop
                  key={offset}
                  offset={offset}
                  style={{ stopColor: `var(--titlebar-${layer.name})` }}
                  stopOpacity={opacity}
                />
              ))}
            </radialGradient>
          ))}
        </defs>
        {LAYERS.map((layer) => (
          <rect
            key={layer.name}
            width="360"
            height="52"
            fill={`url(#${id}-${layer.name})`}
            style={{ fillOpacity: `var(--titlebar-${layer.name}-strength)` }}
          />
        ))}
      </svg>
    </div>
  );
}
