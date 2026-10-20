import type { Result } from "../util/result";
import { isRecord } from "../util/guards";
import type { CdpError } from "./errors";

export type CdpEvent = {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId?: string;
};

export type CdpRawMessage = {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
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

// The identity of an interactive element as seen in one snapshot. Kept on the tab session per ref so the next
// mutation can report what changed without re-running a full snapshot.
export type RefSignature = {
  readonly role: string;
  readonly name: string;
  readonly value: string;
  readonly state: string;
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

// Discriminated so callers can switch on `kind`; the dialog variant keeps a `dialog` property so older `"dialog" in` narrowing still works.
export type PageInfoResult =
  | ({ readonly kind: "page" } & PageInfo)
  | { readonly kind: "dialog"; readonly dialog: DialogInfo };

export type DaemonStatus = {
  readonly alive: boolean;
  readonly sessionId: string | null;
  readonly namespace: string;
  readonly remoteBrowserId?: string;
};

export const isCdpRawMessage = (v: unknown): v is CdpRawMessage => {
  if (!isRecord(v)) return false;
  const id = v["id"];
  if (id !== undefined && typeof id !== "number") return false;
  const method = v["method"];
  if (method !== undefined && typeof method !== "string") return false;
  const sessionId = v["sessionId"];
  if (sessionId !== undefined && typeof sessionId !== "string") return false;
  const params = v["params"];
  if (params !== undefined && !isRecord(params)) return false;
  const errVal = v["error"];
  if (errVal !== undefined) {
    if (!isRecord(errVal)) return false;
    if (typeof errVal["message"] !== "string") return false;
    const code = errVal["code"];
    if (code !== undefined && typeof code !== "number") return false;
  }
  return true;
};

export const DEFAULT_TIMEOUT_MS = 15_000;

export type CdpTransport = {
  connect(url: string, opts?: { timeoutMs?: number }): Promise<Result<void, CdpError>>;
  close(): Promise<void>;
  request(
    method: string,
    params: Record<string, unknown>,
    opts?: { sessionId?: string | null; timeoutMs?: number },
  ): Promise<Result<unknown, CdpError>>;
  events(): AsyncIterable<CdpEvent>;
  state(): "open" | "closed" | "connecting";
  onClose(cb: () => void): () => void;
};
