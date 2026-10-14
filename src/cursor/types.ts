import type { Mutex } from "../util/mutex";
import type { Result } from "../util/result";
import type { ToolErr } from "../util/tool";

export type CursorPoint = { readonly x: number; readonly y: number };
export type CursorButton = "left" | "right" | "middle";
export type CursorVisualStatus = "shown" | "disabled" | "degraded";
export type CursorDiagnostics = {
  readonly status: CursorVisualStatus;
  readonly reason?: string;
};
export type CursorTarget = {
  readonly targetId: string;
  readonly sessionId: string;
};
export type CaptureVisibility = {
  readonly cursorSuppression?: "ok" | "degraded";
  readonly cursorReason?: string;
};

export type CursorVisualSession = {
  isHealthy(): boolean;
  moveTo(point: CursorPoint, immediate?: boolean): Promise<void>;
  moveDrag(point: CursorPoint): Promise<void>;
  press(button: CursorButton): Promise<void>;
  release(button: CursorButton, count: number): Promise<void>;
  showScroll(deltaX: number, deltaY: number): Promise<void>;
};

export type CursorActionResult<T> =
  | { readonly success: true; readonly data: T; readonly diagnostics: CursorDiagnostics }
  | { readonly success: false; readonly error: ToolErr; readonly diagnostics: CursorDiagnostics };

export type CursorCaptureResult<T> =
  | { readonly success: true; readonly data: T; readonly visibility: CaptureVisibility }
  | { readonly success: false; readonly error: ToolErr; readonly visibility: CaptureVisibility };

export type CursorStatus = {
  readonly enabled: boolean;
  readonly targetId?: string;
  readonly diagnostics: CursorDiagnostics;
  readonly idleFadeMs?: number;
};

export type VirtualCursorController = {
  runPointerAction<T>(
    target: CursorTarget,
    signal: AbortSignal | undefined,
    callback: (visual: CursorVisualSession) => Promise<Result<T, ToolErr>>,
  ): Promise<CursorActionResult<T>>;
  withCaptureVisibility<T>(
    includeCursor: boolean,
    capture: (target: CursorTarget) => Promise<Result<T, ToolErr>>,
  ): Promise<CursorCaptureResult<T>>;
  applySessionSettings(cursorEnabled: boolean): Promise<void>;
  status(): CursorStatus;
  forget(targetId: string): Promise<void>;
  prune(liveTargetIds: ReadonlySet<string>): Promise<void>;
  clear(): Promise<void>;
};

export type VirtualCursorOptions = {
  readonly enabled?: boolean;
  readonly cursorMutex?: Mutex;
};
