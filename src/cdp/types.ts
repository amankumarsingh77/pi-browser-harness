export type CdpEvent = {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
};

export type CdpRawMessage = {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly code?: number };
  readonly sessionId?: string;
};

export type DialogInfo = {
  readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
  readonly message: string;
  readonly defaultPrompt?: string;
};

export type TabInfo = {
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
};

export type PageInfo = {
  readonly url: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly pageWidth: number;
  readonly pageHeight: number;
};

export type DaemonStatus = {
  readonly alive: boolean;
  readonly sessionId: string | null;
  readonly namespace: string;
  readonly remoteBrowserId?: string;
};

const INTERNAL_PREFIXES: ReadonlyArray<string> = [
  "chrome://", "chrome-untrusted://", "devtools://", "chrome-extension://", "about:",
];

export const isInternalUrl = (url: string): boolean =>
  INTERNAL_PREFIXES.some((p) => url.startsWith(p));
