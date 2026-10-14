const STORAGE_KEY = "prkit.sessionToken";

/**
 * Takes `?token=` from the first load into sessionStorage and strips it from the
 * address bar, so the token never lands in history or a copied URL. Call before
 * the router reads the location.
 */
export function captureSessionToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token === null) return;
  window.sessionStorage.setItem(STORAGE_KEY, token);
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, "", url);
}

export const readSessionToken = (): string | null => window.sessionStorage.getItem(STORAGE_KEY);
