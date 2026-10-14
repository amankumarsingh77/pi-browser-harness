import type { BrowserClient } from "../client";
import { createMutex } from "../util/mutex";
import type { Result } from "../util/result";
import type { ToolErr } from "../util/tool";
import { ensureOverlay, runOverlayCommand, type OverlayState } from "./page-overlay";
import type {
  CaptureVisibility,
  CursorActionResult,
  CursorButton,
  CursorCaptureResult,
  CursorDiagnostics,
  CursorPoint,
  CursorStatus,
  CursorTarget,
  CursorVisualSession,
  VirtualCursorController,
  VirtualCursorOptions,
} from "./types";

const IDLE_FADE_MS = 1_200;
const DEGRADED_COOLDOWN_MS = 5_000;

type TargetState = {
  point?: CursorPoint;
  sessionId: string;
  ready: boolean;
  reducedMotion: boolean;
  diagnostics: CursorDiagnostics;
  degradedUntil: number;
  idleFadeUntil?: number;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
};

const disabled: CursorDiagnostics = { status: "disabled" };
const shown: CursorDiagnostics = { status: "shown" };

const failed = (message: string): ToolErr => ({ kind: "invalid_state", message });

const distanceDuration = (from: CursorPoint, to: CursorPoint): number => {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.min(180, Math.max(60, Math.round(distance / 3)));
};

export const createVirtualCursorController = (
  client: BrowserClient,
  options: VirtualCursorOptions,
): VirtualCursorController => {
  const cursorMutex = options.cursorMutex ?? createMutex();
  const states = new Map<string, TargetState>();
  let enabled = options.enabled ?? true;
  let recentDiagnostics: CursorDiagnostics = enabled ? shown : disabled;
  let recentTargetId: string | undefined;

  const withCursorLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = await cursorMutex.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const stateFor = (target: CursorTarget): TargetState => {
    const existing = states.get(target.targetId);
    if (existing) {
      existing.sessionId = target.sessionId;
      return existing;
    }
    const state: TargetState = {
      sessionId: target.sessionId,
      ready: false,
      reducedMotion: false,
      diagnostics: shown,
      degradedUntil: 0,
    };
    states.set(target.targetId, state);
    return state;
  };

  const degrade = (state: TargetState, reason: string): void => {
    state.ready = false;
    state.diagnostics = { status: "degraded", reason };
    state.degradedUntil = Date.now() + DEGRADED_COOLDOWN_MS;
    recentDiagnostics = state.diagnostics;
  };

  const clearIdleFade = (state: TargetState): void => {
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    delete state.idleFadeUntil;
  };

  const scheduleIdleFade = (state: TargetState): void => {
    clearIdleFade(state);
    const deadline = Date.now() + IDLE_FADE_MS;
    scheduleIdleFadeAt(state, deadline);
  };

  const scheduleIdleFadeAt = (state: TargetState, deadline: number): void => {
    clearIdleFade(state);
    state.idleFadeUntil = deadline;
    state.idleTimer = setTimeout(() => {
      void withCursorLock(async () => {
        if (state.idleFadeUntil !== deadline) return;
        state.idleTimer = undefined;
        await command(state, "hide");
      });
    }, Math.max(0, deadline - Date.now()));
  };

  const ready = async (state: TargetState): Promise<boolean> => {
    if (Date.now() < state.degradedUntil) return false;
    if (state.ready) return true;
    const overlay = await ensureOverlay(client, state.sessionId);
    if (!overlay.success) {
      degrade(state, overlay.error.message);
      return false;
    }
    state.ready = true;
    state.reducedMotion = overlay.data.reducedMotion;
    state.diagnostics = shown;
    recentDiagnostics = shown;
    return true;
  };

  const command = async (
    state: TargetState,
    name: "move" | "press" | "release" | "scroll" | "hide" | "show" | "destroy",
    payload?: Readonly<Record<string, unknown>>,
  ): Promise<OverlayState | undefined> => {
    if (!(await ready(state))) return undefined;
    let result = await runOverlayCommand(client, state.sessionId, name, payload);
    if (!result.success && result.error.message === "cursor overlay is not installed") {
      state.ready = false;
      if (!(await ready(state))) return undefined;
      result = await runOverlayCommand(client, state.sessionId, name, payload);
    }
    if (!result.success) {
      degrade(state, result.error.message);
      return undefined;
    }
    if (result.data.topLayerOverlap === true) {
      degrade(state, "cursor point is covered by the Top Layer");
      return undefined;
    }
    state.reducedMotion = result.data.reducedMotion;
    state.diagnostics = shown;
    recentDiagnostics = shown;
    return result.data;
  };

  const visualSession = (target: CursorTarget): CursorVisualSession => {
    const state = stateFor(target);
    const move = async (point: CursorPoint, immediate = false): Promise<void> => {
      const duration = immediate || state.point === undefined || state.reducedMotion
        ? 0
        : distanceDuration(state.point, point);
      const moved = await command(state, "move", { x: point.x, y: point.y, duration });
      if (moved === undefined) return;
      state.point = point;
      scheduleIdleFade(state);
      recentTargetId = target.targetId;
    };
    return {
      isHealthy: () => state.diagnostics.status === "shown",
      moveTo: move,
      moveDrag: move,
      press: async (button: CursorButton): Promise<void> => {
        await command(state, "press", { button });
      },
      release: async (button: CursorButton, count: number): Promise<void> => {
        await command(state, "release", { button, count });
      },
      showScroll: async (deltaX: number, deltaY: number): Promise<void> => {
        await command(state, "scroll", { deltaX, deltaY });
      },
    };
  };

  const runPointerAction = async <T>(
    target: CursorTarget,
    _signal: AbortSignal | undefined,
    callback: (visual: CursorVisualSession) => Promise<Result<T, ToolErr>>,
  ): Promise<CursorActionResult<T>> => withCursorLock(async () => {
    const visual = enabled ? visualSession(target) : {
      isHealthy: () => false,
      moveTo: async () => {},
      moveDrag: async () => {},
      press: async () => {},
      release: async () => {},
      showScroll: async () => {},
    };
    const input = await callback(visual);
    const diagnostics = enabled ? stateFor(target).diagnostics : disabled;
    recentDiagnostics = diagnostics;
    recentTargetId = target.targetId;
    return input.success
      ? { success: true, data: input.data, diagnostics }
      : { success: false, error: input.error, diagnostics };
  });

  const withCaptureVisibility = async <T>(
    includeCursor: boolean,
    capture: (target: CursorTarget) => Promise<Result<T, ToolErr>>,
  ): Promise<CursorCaptureResult<T>> => withCursorLock(async () => {
    const current = client.current();
    const state = current ? states.get(current.targetId) : undefined;
    const emptyVisibility: CaptureVisibility = {};
    if (includeCursor) {
      if (!enabled) return { success: false, error: failed("virtual cursor is disabled"), visibility: emptyVisibility };
      if (!current || !state?.point) {
        return { success: false, error: failed("virtual cursor has no saved position"), visibility: emptyVisibility };
      }
      if (Date.now() < state.degradedUntil) {
        return { success: false, error: failed(state.diagnostics.reason ?? "virtual cursor is degraded"), visibility: emptyVisibility };
      }
      const priorIdleFadeUntil = state.idleFadeUntil;
      clearIdleFade(state);
      const visible = await command(state, "show", { strict: true });
      if (visible === undefined) {
        if (priorIdleFadeUntil !== undefined) {
          scheduleIdleFadeAt(state, priorIdleFadeUntil);
        }
        return { success: false, error: failed(state.diagnostics.reason ?? "virtual cursor could not be shown"), visibility: emptyVisibility };
      }
      try {
        const result = await capture(current);
        return result.success
          ? { success: true, data: result.data, visibility: { cursorSuppression: "ok" } }
          : { success: false, error: result.error, visibility: { cursorSuppression: "ok" } };
      } finally {
        if (priorIdleFadeUntil !== undefined) {
          scheduleIdleFadeAt(state, priorIdleFadeUntil);
        }
      }
    }

    let visibility: CaptureVisibility = { cursorSuppression: "ok" };
    if (!current) {
      return { success: false, error: failed("no browser target is attached"), visibility };
    }
    const currentState = state ?? stateFor(current);
    if ((await command(currentState, "hide", { immediate: true })) === undefined) {
      const reason = currentState.diagnostics.reason;
      visibility = {
        cursorSuppression: "degraded",
        ...(reason === undefined ? {} : { cursorReason: reason }),
      };
    }
    try {
      const result = await capture(current);
      return result.success
        ? { success: true, data: result.data, visibility }
        : { success: false, error: result.error, visibility };
    } finally {
      if (state?.point) await command(state, "show");
    }
  });

  const applySessionSettings = async (cursorEnabled: boolean): Promise<void> => {
    const releaseMutation = await client.mutationMutex().acquire();
    try {
      await withCursorLock(async () => {
        enabled = cursorEnabled;
        if (enabled) {
          recentDiagnostics = shown;
          return;
        }
        recentDiagnostics = disabled;
        const tabs = await client.listTabs();
        if (!tabs.success) return;
        const liveTargetIds = new Set(tabs.data.map((tab) => tab.targetId));
        for (const [targetId, state] of states) {
          clearIdleFade(state);
          if (!liveTargetIds.has(targetId)) continue;
          const attached = await client.session().attach(targetId);
          if (!attached.success) {
            degrade(state, attached.error.message);
            continue;
          }
          try {
            state.sessionId = attached.data;
            await command(state, "destroy");
          } finally {
            await client.session().detach(attached.data);
          }
        }
      });
    } finally {
      releaseMutation();
    }
  };

  return {
    runPointerAction,
    withCaptureVisibility,
    applySessionSettings,
    status: (): CursorStatus => {
      const state = recentTargetId ? states.get(recentTargetId) : undefined;
      const idleFadeMs = state?.idleFadeUntil === undefined
        ? undefined
        : Math.max(0, state.idleFadeUntil - Date.now());
      return {
        enabled,
        ...(recentTargetId === undefined ? {} : { targetId: recentTargetId }),
        diagnostics: state?.diagnostics ?? recentDiagnostics,
        ...(idleFadeMs === undefined ? {} : { idleFadeMs }),
      };
    },
    forget: async (targetId: string): Promise<void> => {
      await withCursorLock(async () => {
        const state = states.get(targetId);
        if (state) clearIdleFade(state);
        states.delete(targetId);
        if (recentTargetId === targetId) recentTargetId = undefined;
      });
    },
    prune: async (liveTargetIds: ReadonlySet<string>): Promise<void> => {
      await withCursorLock(async () => {
        for (const targetId of states.keys()) {
          if (!liveTargetIds.has(targetId)) {
            const state = states.get(targetId);
            if (state) clearIdleFade(state);
            states.delete(targetId);
          }
        }
        if (recentTargetId && !liveTargetIds.has(recentTargetId)) recentTargetId = undefined;
      });
    },
    clear: async (): Promise<void> => {
      await withCursorLock(async () => {
        for (const state of states.values()) clearIdleFade(state);
        states.clear();
        recentTargetId = undefined;
      });
    },
  };
};
