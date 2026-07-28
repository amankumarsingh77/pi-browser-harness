import { decodeEvent, type EventParamsOf } from "./events";
import { createRecordStore } from "./record-store";

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

type UpdateEvent = "Network.responseReceived" | "Network.loadingFinished" | "Network.loadingFailed";

export const createNetworkBuffer = (capacity = 500): NetworkBuffer => {
  const records = createRecordStore<string, NetworkRecord>(capacity);

  // All three follow-up events say the same thing first: decode, find the request they belong to, give up quietly if it is gone.
  const update = <E extends UpdateEvent>(
    method: E,
    p: unknown,
    apply: (r: NetworkRecord, params: EventParamsOf<E>) => void,
  ): void => {
    const decoded = decodeEvent(method, p);
    if (!decoded.success) return;
    const id = decoded.data.requestId;
    if (!id) return;
    const r = records.get(id);
    if (!r) return;
    apply(r, decoded.data);
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
      update("Network.responseReceived", p, (r, params) => {
        if (params.response?.status !== undefined) r.status = params.response.status;
        if (params.response?.statusText !== undefined && params.response.statusText !== "") r.statusText = params.response.statusText;
        if (params.response?.mimeType !== undefined) r.mimeType = params.response.mimeType;
        // type is more accurate on responseReceived (CDP sometimes refines it)
        if (params.type !== undefined) r.type = params.type;
      });
    },

    ingestLoadingFinished(p) {
      update("Network.loadingFinished", p, (r, params) => {
        if (params.encodedDataLength !== undefined) r.responseBodySize = params.encodedDataLength;
        r.durationMs = Date.now() - r.requestStartedMs;
      });
    },

    ingestLoadingFailed(p) {
      update("Network.loadingFailed", p, (r, params) => {
        r.failed = true;
        if (params.errorText !== undefined) r.errorText = params.errorText;
        r.durationMs = Date.now() - r.requestStartedMs;
      });
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

      return records.page(matched, filter.limit);
    },

    clear() {
      records.clear();
    },
  };
};
