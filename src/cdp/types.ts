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
  readonly owned?: boolean;
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

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isCdpRawMessage = (v: unknown): v is CdpRawMessage => {
  if (!isObject(v)) return false;
  const id = v["id"];
  if (id !== undefined && typeof id !== "number") return false;
  const method = v["method"];
  if (method !== undefined && typeof method !== "string") return false;
  const sessionId = v["sessionId"];
  if (sessionId !== undefined && typeof sessionId !== "string") return false;
  const errVal = v["error"];
  if (errVal !== undefined) {
    if (!isObject(errVal)) return false;
    if (typeof errVal["message"] !== "string") return false;
    const code = errVal["code"];
    if (code !== undefined && typeof code !== "number") return false;
  }
  return true;
};
