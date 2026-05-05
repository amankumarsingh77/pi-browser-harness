/**
 * In-memory aggregator for CDP Network.* events.
 *
 * The CDP event stream is consumed by a single internal loop in session.ts.
 * That loop hands Network.* event params to this module, which joins them into
 * one record per requestId (request → response → finished/failed). Tools then
 * read records via drain(), filtered to what the caller asked for.
 *
 * Bounded by a fixed capacity (default 500): on overflow the oldest record is
 * evicted FIFO. The overflow flag is reported once per drain so tools can warn
 * the LLM that data may be missing.
 *
 * This module is pure (no CDP dependency) so the joining/filtering logic stays
 * trivially testable in isolation.
 */

export type NetworkRecord = {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  type: string;
  mimeType?: string;
  /** Wall-clock ms when requestWillBeSent fired, in Date.now() units. */
  requestStartedMs: number;
  durationMs?: number;
  requestBodySize: number;
  responseBodySize?: number;
  failed?: boolean;
  errorText?: string;
  /** Populated by the tool layer via Network.getResponseBody, never by the aggregator. */
  body?: string | null;
};

export type NetworkFilter = {
  /** Substring match by default. Wrap in slashes (`/foo/`) for regex. */
  urlPattern?: string;
  methodFilter?: string[];
  statusFilter?: { min?: number; max?: number };
  resourceTypes?: string[];
  /** Only requests whose start is at most N ms ago. */
  sinceMs?: number;
  /** Cap on the returned records. */
  limit?: number;
};

export type DrainResult = {
  readonly records: NetworkRecord[];
  /** Total matches before `limit` was applied. */
  readonly total: number;
  /** True if the ring buffer evicted at least one record since the last drain. */
  readonly bufferOverflowed: boolean;
};

export type NetworkBuffer = {
  ingestRequestWillBeSent(p: unknown): void;
  ingestResponseReceived(p: unknown): void;
  ingestLoadingFinished(p: unknown): void;
  ingestLoadingFailed(p: unknown): void;
  drain(filter: NetworkFilter): DrainResult;
  clear(): void;
};

const compileUrlMatcher = (pattern: string): ((url: string) => boolean) => {
  if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return (url) => re.test(url);
    } catch {
      // Fall through to substring match if the pattern is not a valid regex.
    }
  }
  return (url) => url.includes(pattern);
};

export const createNetworkBuffer = (capacity = 500): NetworkBuffer => {
  // Insertion-ordered map keyed by requestId. Map preserves insertion order in JS,
  // so iteration gives us oldest-first eviction without a separate index.
  const records = new Map<string, NetworkRecord>();
  let overflowed = false;

  const evictOldestIfFull = (): void => {
    while (records.size >= capacity) {
      const oldest = records.keys().next();
      if (oldest.done) return;
      records.delete(oldest.value);
      overflowed = true;
    }
  };

  return {
    ingestRequestWillBeSent(p) {
      // CDP boundary cast: Network.requestWillBeSent
      const params = p as
        | {
            requestId?: string;
            request?: {
              url?: string;
              method?: string;
              postData?: string;
              headers?: Record<string, string>;
            };
            type?: string;
            timestamp?: number;
            wallTime?: number;
          }
        | undefined;
      const id = params?.requestId;
      const url = params?.request?.url;
      const method = params?.request?.method;
      if (!id || !url || !method) return;
      // Re-fired requestWillBeSent for the same id (e.g. redirect) — refresh in place.
      records.delete(id);
      evictOldestIfFull();
      const postData = params.request?.postData;
      records.set(id, {
        requestId: id,
        method,
        url,
        type: params.type ?? "Other",
        requestStartedMs: Date.now(),
        requestBodySize: postData ? Buffer.byteLength(postData, "utf8") : 0,
      });
    },

    ingestResponseReceived(p) {
      // CDP boundary cast: Network.responseReceived
      const params = p as
        | {
            requestId?: string;
            response?: {
              status?: number;
              statusText?: string;
              mimeType?: string;
            };
            type?: string;
          }
        | undefined;
      const id = params?.requestId;
      if (!id) return;
      const r = records.get(id);
      if (!r) return;
      if (params?.response?.status !== undefined) r.status = params.response.status;
      if (params?.response?.statusText !== undefined && params.response.statusText !== "") r.statusText = params.response.statusText;
      if (params?.response?.mimeType !== undefined) r.mimeType = params.response.mimeType;
      // type is more accurate on responseReceived (CDP sometimes refines it)
      if (params?.type !== undefined) r.type = params.type;
    },

    ingestLoadingFinished(p) {
      // CDP boundary cast: Network.loadingFinished
      const params = p as
        | { requestId?: string; encodedDataLength?: number }
        | undefined;
      const id = params?.requestId;
      if (!id) return;
      const r = records.get(id);
      if (!r) return;
      if (params?.encodedDataLength !== undefined) r.responseBodySize = params.encodedDataLength;
      r.durationMs = Date.now() - r.requestStartedMs;
    },

    ingestLoadingFailed(p) {
      // CDP boundary cast: Network.loadingFailed
      const params = p as
        | { requestId?: string; errorText?: string; canceled?: boolean }
        | undefined;
      const id = params?.requestId;
      if (!id) return;
      const r = records.get(id);
      if (!r) return;
      r.failed = true;
      if (params?.errorText !== undefined) r.errorText = params.errorText;
      r.durationMs = Date.now() - r.requestStartedMs;
    },

    drain(filter) {
      const matchUrl = filter.urlPattern !== undefined ? compileUrlMatcher(filter.urlPattern) : undefined;
      const methods = filter.methodFilter ? new Set(filter.methodFilter.map((m) => m.toUpperCase())) : undefined;
      const types = filter.resourceTypes ? new Set(filter.resourceTypes.map((t) => t.toLowerCase())) : undefined;
      const minStatus = filter.statusFilter?.min;
      const maxStatus = filter.statusFilter?.max;
      const cutoff = filter.sinceMs !== undefined ? Date.now() - filter.sinceMs : undefined;

      const matched: NetworkRecord[] = [];
      for (const r of records.values()) {
        if (matchUrl && !matchUrl(r.url)) continue;
        if (methods && !methods.has(r.method.toUpperCase())) continue;
        if (types && !types.has(r.type.toLowerCase())) continue;
        if (cutoff !== undefined && r.requestStartedMs < cutoff) continue;
        if (minStatus !== undefined && (r.status === undefined || r.status < minStatus)) continue;
        if (maxStatus !== undefined && (r.status === undefined || r.status > maxStatus)) continue;
        // Clone so callers can mutate (e.g. attach body) without polluting the buffer.
        matched.push({ ...r });
      }

      const total = matched.length;
      const limit = Math.min(filter.limit ?? 50, 500);
      const limited = matched.slice(-limit); // most recent N

      const bufferOverflowed = overflowed;
      overflowed = false;

      return { records: limited, total, bufferOverflowed };
    },

    clear() {
      records.clear();
      overflowed = false;
    },
  };
};
