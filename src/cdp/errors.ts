export type CdpErrorKind =
  | "transport_closed"
  | "timeout"
  | "session_not_found"
  | "remote_error"
  | "discovery_failed"
  | "invalid_response";

export type CdpError = {
  readonly kind: CdpErrorKind;
  readonly message: string;
  readonly method?: string;
};

// Chrome reports a dead session as a generic protocol error, so the message text is the only signal that a reattach — not a retry — is what will fix it.
export const classifyRemoteError = (message: string): CdpErrorKind =>
  message.includes("Session with given id not found") ? "session_not_found" : "remote_error";

export const cdpError = (
  kind: CdpErrorKind,
  message: string,
  method?: string,
): CdpError => ({ kind, message, ...(method !== undefined ? { method } : {}) });
