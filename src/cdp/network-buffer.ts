import { decodeEvent } from "./events";

export type NetworkRecord = {
  requestId: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  type: string;
  mimeType?: string;
  requestStartedMs: number;
  durationMs?: number;
  requestBodySize: number;
  responseBodySize?: number;
  failed?: boolean;
  errorText?: string;
  body?: string | null;
};

export type NetworkFilter = {
  urlPattern?: string;
  methodFilter?: string[];
  statusFilter?: { min?: number; max?: number };
  resourceTypes?: string[];
  sinceMs?: number;
  limit?: number;
};

export type DrainResult = {
  readonly records: NetworkRecord[];
  readonly total: number;
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
    } catch {}
  }
  return (url) => url.includes(pattern);
};

export const createNetworkBuffer = (capacity = 500): NetworkBuffer => {
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
      const decoded = decodeEvent("Network.requestWillBeSent", p);
      const params = decoded.success ? decoded.data : undefined;
      const id = params?.requestId;
      const url = params?.request.url;
      const method = params?.request.method;
      if (!id || !url || !method) return;
      records.delete(id);
      evictOldestIfFull();
      const postData = params.request.postData;
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
      const decoded = decodeEvent("Network.responseReceived", p);
      const params = decoded.success ? decoded.data : undefined;
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
      const decoded = decodeEvent("Network.loadingFinished", p);
      const params = decoded.success ? decoded.data : undefined;
      const id = params?.requestId;
      if (!id) return;
      const r = records.get(id);
      if (!r) return;
      if (params?.encodedDataLength !== undefined) r.responseBodySize = params.encodedDataLength;
      r.durationMs = Date.now() - r.requestStartedMs;
    },

    ingestLoadingFailed(p) {
      const decoded = decodeEvent("Network.loadingFailed", p);
      const params = decoded.success ? decoded.data : undefined;
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
        matched.push({ ...r });
      }

      const total = matched.length;
      const limit = Math.min(filter.limit ?? 50, 500);
      const limited = matched.slice(-limit);

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
