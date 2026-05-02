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

export const cdpError = (
  kind: CdpErrorKind,
  message: string,
  method?: string,
): CdpError => ({ kind, message, ...(method !== undefined ? { method } : {}) });
