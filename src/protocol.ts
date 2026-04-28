/**
 * Protocol types for pi-browser-harness.
 *
 * Defines the shape of CDP communication and browser state.
 * No socket transport — the daemon talks CDP directly over WebSocket.
 */

// ── CDP Event ────────────────────────────────────────────────────────────────

export interface CDPEvent {
  method: string;
  params: unknown;
  session_id?: string;
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

// ── Tab ──────────────────────────────────────────────────────────────────────

export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

// ── Page State ───────────────────────────────────────────────────────────────

export interface PageInfo {
  url: string;
  title: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  pageWidth: number;
  pageHeight: number;
}

export type PageInfoResult = PageInfo | { dialog: DialogInfo };

// ── Daemon Status ────────────────────────────────────────────────────────────

export interface DaemonStatus {
  alive: boolean;
  sessionId: string | null;
  pid: number | null; // deprecated — always null (no subprocess)
  namespace: string;
  socketPath: string; // deprecated — always "" (no socket)
  remoteBrowserId?: string;
}

// ── Remote Config ────────────────────────────────────────────────────────────

export interface RemoteConfig {
  cdpUrl: string;
  browserId: string;
}

// ── Internal URL prefixes to filter ──────────────────────────────────────────

const INTERNAL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "about:",
];

export function isInternalUrl(url: string): boolean {
  return INTERNAL_PREFIXES.some((p) => url.startsWith(p));
}
