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

export type InputKind = "move" | "click";

export type StopReason = "stopped" | "capped" | "session_end";

export type RecordingSummary = {
  readonly path: string;
  readonly durationSec: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly frozenSec: number;
  readonly framesReceived: number;
};

// A plain message rather than ToolErr: cdp/ must not import from domains/ or the tool runtime layer, so the domain that builds a RecordingSink maps this to a ToolErr itself.
export type RecordingFinalizeError = {
  readonly message: string;
};

// Lives here, not in domains/, because cdp/session.ts owns the active recording (docs/ARCHITECTURE.md) and must reference this type without importing from domains/.
export type RecordingSink = {
  readonly outputPath: string;
  // Whether the window was successfully moved off-screen at start — record.ts reads this to tell the caller whether it's safe to leave the window alone (docs/ARCHITECTURE.md).
  readonly parked: boolean;
  onFrame(data: string): void;
  noteInput(x: number, y: number, kind: InputKind): void;
  noteConsumerRestart(): void;
  finalize(reason: StopReason): Promise<Result<RecordingSummary, RecordingFinalizeError>>;
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

export const isCdpRawMessage = (v: unknown): v is CdpRawMessage => {
  if (!isRecord(v)) return false;
  const id = v["id"];
  if (id !== undefined && typeof id !== "number") return false;
  const method = v["method"];
  if (method !== undefined && typeof method !== "string") return false;
  const sessionId = v["sessionId"];
  if (sessionId !== undefined && typeof sessionId !== "string") return false;
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
