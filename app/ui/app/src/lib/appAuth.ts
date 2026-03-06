import { APP_AUTH_PROVIDER, APP_AUTH_SIGNIN_URL } from "@/api";

const APP_AUTH_STORAGE_KEY = "anorha.app.auth.signed_in";

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function isAppAuthEnabled(): boolean {
  return APP_AUTH_PROVIDER === "clerk" && APP_AUTH_SIGNIN_URL.length > 0;
}

export function isAppSignedIn(): boolean {
  if (!isAppAuthEnabled()) return true;
  if (!hasWindow()) return false;
  return window.localStorage.getItem(APP_AUTH_STORAGE_KEY) === "1";
}

export function markAppSignedIn(): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(APP_AUTH_STORAGE_KEY, "1");
}

export function clearAppSignedIn(): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(APP_AUTH_STORAGE_KEY);
}

