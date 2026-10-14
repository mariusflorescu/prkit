/**
 * A thin determinate bar. It moves only when a real count changes (a file read, a
 * chapter written), with a short ease-out, and never animates while idle.
 */
export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label="Guide progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={label}
      className="h-0.5 w-full shrink-0 overflow-hidden rounded-full bg-border"
    >
      <div
        className="h-full origin-left bg-primary transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  );
}
