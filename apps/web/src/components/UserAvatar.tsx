import { cn } from "~/lib/utils";

export function UserAvatar({
  login,
  url,
  size = "small",
}: {
  login: string;
  url: string | null;
  size?: "small" | "medium" | "large";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-muted-foreground",
        size === "large"
          ? "size-9 text-sm"
          : size === "medium"
            ? "size-7 text-xs"
            : "size-3.5 text-3xs",
      )}
    >
      {login.slice(0, 1).toUpperCase()}
      {url && (
        <img
          src={url}
          alt=""
          width={size === "large" ? 36 : size === "medium" ? 28 : 14}
          height={size === "large" ? 36 : size === "medium" ? 28 : 14}
          loading="lazy"
          className="absolute inset-0 size-full"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}
