import type { BrowserClient } from "../client";
import { evalJs } from "../domains/cdp-call";
import type { ToolErr } from "../util/tool";
import { err, ok, type Result } from "../util/result";

export type OverlayState = {
  readonly version: number;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly reducedMotion: boolean;
  readonly topLayerOverlap?: boolean;
};

export type CursorCommand =
  | "move"
  | "press"
  | "release"
  | "scroll"
  | "hide"
  | "show"
  | "destroy"
  | "snapshot";

export const CURSOR_BOOTSTRAP_SOURCE = String.raw`(() => {
  const key = Symbol.for("pi-browser-harness.cursor.v1");
  const version = 1;
  const stateOf = (api) => ({
    version: api.version,
    connected: api.host.isConnected,
    visible: api.visible,
    reducedMotion: api.reducedMotion,
  });
  const existing = globalThis[key];
  if (existing && existing.version === version && existing.host && existing.host.isConnected) {
    existing.reset();
    return stateOf(existing);
  }
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("tabindex", "-1");
  const reset = () => {
    const critical = {
      display: "block",
      visibility: "visible",
      opacity: "1",
      position: "fixed",
      "pointer-events": "none",
      contain: "strict",
      "z-index": "2147483647",
      inset: "0",
    };
    for (const [name, value] of Object.entries(critical)) host.style.setProperty(name, value, "important");
  };
  reset();
  const shadow = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    ".cursor{position:fixed;left:0;top:0;width:0;height:0;transform:translate3d(var(--x,0px),var(--y,0px),0);transition:transform var(--duration,0ms) linear,opacity 120ms linear;opacity:1}" +
    ".cursor.idle{opacity:0}.arrow{width:0;height:0;border-top:8px solid transparent;border-bottom:8px solid transparent;border-left:13px solid #fff;filter:drop-shadow(0 0 2px #000)}" +
    ".cursor.pressed .arrow{transform:scale(.85)}.ring{position:absolute;width:24px;height:24px;margin:-12px;border:2px solid #4da3ff;border-radius:50%;opacity:0}" +
    ".cursor.pulse .ring{animation:pulse 220ms linear}.scroll{position:absolute;margin:12px;color:#fff;text-shadow:0 0 2px #000;opacity:0}.cursor.scrolling .scroll{opacity:1}" +
    "@keyframes pulse{from{opacity:1;transform:scale(.3)}to{opacity:0;transform:scale(1)}}"
  );
  shadow.adoptedStyleSheets = [sheet];
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  const arrow = document.createElement("div");
  arrow.className = "arrow";
  const ring = document.createElement("div");
  ring.className = "ring";
  const scroll = document.createElement("div");
  scroll.className = "scroll";
  cursor.append(arrow, ring, scroll);
  shadow.append(cursor);
  (document.documentElement || document.body).append(host);
  const api = {
    version,
    host,
    visible: true,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    x: 0,
    y: 0,
    reset,
    command(request) {
      reset();
      const computed = getComputedStyle(host);
      if (computed.display === "none" || computed.visibility === "hidden" || computed.pointerEvents !== "none") {
        return { ok: false, reason: "critical cursor host styles were overridden" };
      }
      if (request.command === "move") {
        api.x = request.x;
        api.y = request.y;
        cursor.style.setProperty("--x", request.x + "px");
        cursor.style.setProperty("--y", request.y + "px");
        cursor.style.setProperty("--duration", request.duration + "ms");
        cursor.classList.remove("idle");
        api.visible = true;
      } else if (request.command === "press") {
        cursor.classList.add("pressed");
      } else if (request.command === "release") {
        cursor.classList.remove("pressed");
        cursor.classList.remove("pulse");
        void cursor.offsetWidth;
        cursor.classList.add("pulse");
      } else if (request.command === "scroll") {
        scroll.textContent = request.deltaY < 0 ? "↑" : request.deltaY > 0 ? "↓" : request.deltaX < 0 ? "←" : "→";
        cursor.classList.add("scrolling");
        setTimeout(() => cursor.classList.remove("scrolling"), 220);
      } else if (request.command === "hide") {
        cursor.classList.add("idle");
        api.visible = false;
      } else if (request.command === "show") {
        const top = document.fullscreenElement
          || document.querySelector("dialog:modal")
          || (CSS.supports("selector(:popover-open)") ? document.querySelector(":popover-open") : null);
        if (request.strict && top && top.contains(document.elementFromPoint(api.x, api.y))) {
          return { ok: false, reason: "cursor point is covered by the Top Layer", topLayerOverlap: true };
        }
        cursor.classList.remove("idle");
        api.visible = true;
      } else if (request.command === "destroy") {
        host.remove();
      }
      return { ok: true, ...stateOf(api), x: api.x, y: api.y };
    },
  };
  Object.defineProperty(globalThis, key, { value: api, configurable: true, enumerable: false });
  return stateOf(api);
})()`;

const validOverlayState = (value: unknown): value is OverlayState => {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  return "version" in record
    && "connected" in record
    && "visible" in record
    && "reducedMotion" in record
    && typeof record.version === "number"
    && typeof record.connected === "boolean"
    && typeof record.visible === "boolean"
    && typeof record.reducedMotion === "boolean";
};

export const cursorCommandExpression = (
  command: CursorCommand,
  payload: Readonly<Record<string, unknown>> = {},
): string => JSON.stringify({
  source: "pi-browser-harness.cursor.v1",
  command,
  ...payload,
}).replace(
  /^\{(.+)\}$/,
  "(() => { const api = globalThis[Symbol.for(\"pi-browser-harness.cursor.v1\")]; return api ? api.command({$1}) : { ok: false, reason: \"cursor overlay is not installed\" }; })()",
);

const malformedState = (): Result<OverlayState, ToolErr> =>
  err({ kind: "invalid_state", message: "cursor overlay returned an invalid state" });

export const ensureOverlay = async (
  client: BrowserClient,
  sessionId: string,
): Promise<Result<OverlayState, ToolErr>> => {
  const result = await evalJs(client, CURSOR_BOOTSTRAP_SOURCE, sessionId);
  if (!result.success) return result;
  if (!validOverlayState(result.data)) return malformedState();
  if (result.data.version !== 1 || !result.data.connected || !result.data.visible) {
    return err({ kind: "invalid_state", message: "cursor overlay is not connected and visible" });
  }
  return ok(result.data);
};

export const runOverlayCommand = async (
  client: BrowserClient,
  sessionId: string,
  command: CursorCommand,
  payload?: Readonly<Record<string, unknown>>,
): Promise<Result<OverlayState, ToolErr>> => {
  const result = await evalJs(client, cursorCommandExpression(command, payload), sessionId);
  if (!result.success) return result;
  if (!validOverlayState(result.data)) return malformedState();
  return ok(result.data);
};
