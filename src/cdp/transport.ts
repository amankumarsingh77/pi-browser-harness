import type { Result } from "../util/result";
import type { CdpError } from "./errors";
import type { CdpEvent } from "./types";

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
