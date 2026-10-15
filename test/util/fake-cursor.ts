import type {
  CursorCaptureResult,
  CursorStatus,
  CursorTarget,
  CursorVisualSession,
  VirtualCursorController,
} from "../../src/cursor/types";
import type { ToolErr } from "../../src/util/tool";
import type { Result } from "../../src/util/result";

export type FakeCursor = VirtualCursorController & {
  readonly appliedSettings: boolean[];
  readonly forgotten: string[];
  readonly prunedWith: Array<ReadonlyArray<string>>;
  readonly calls: string[];
};

const visual: CursorVisualSession = {
  isHealthy: () => true,
  moveTo: async () => {},
  waitForMove: async () => {},
  moveDrag: async () => {},
  press: async () => {},
  release: async () => {},
  showScroll: async () => {},
};

export const createFakeCursor = (
  status: CursorStatus = { enabled: true, diagnostics: { status: "shown" } },
  onCall?: (call: string) => void,
): FakeCursor => {
  let currentStatus = status;
  const appliedSettings: boolean[] = [];
  const forgotten: string[] = [];
  const prunedWith: Array<ReadonlyArray<string>> = [];
  const calls: string[] = [];
  const record = (call: string): void => {
    calls.push(call);
    onCall?.(call);
  };

  return {
    appliedSettings,
    forgotten,
    prunedWith,
    calls,
    runPointerAction: async <T>(
      _target: CursorTarget,
      _signal: AbortSignal | undefined,
      callback: (session: CursorVisualSession) => Promise<Result<T, ToolErr>>,
    ) => {
      const result = await callback(visual);
      return result.success
        ? { success: true, data: result.data, diagnostics: currentStatus.diagnostics }
        : { success: false, error: result.error, diagnostics: currentStatus.diagnostics };
    },
    withCaptureVisibility: async <T>(
      _includeCursor: boolean,
      capture: (_target: CursorTarget) => Promise<Result<T, ToolErr>>,
    ): Promise<CursorCaptureResult<T>> => {
      const result = await capture({ targetId: "t1", sessionId: "s1" });
      return result.success
        ? { success: true, data: result.data, visibility: {} }
        : { success: false, error: result.error, visibility: {} };
    },
    applySessionSettings: async (enabled) => {
      currentStatus = { ...currentStatus, enabled };
      appliedSettings.push(enabled);
      record(`apply:${enabled}`);
    },
    status: () => currentStatus,
    forget: async (targetId) => {
      forgotten.push(targetId);
      record(`forget:${targetId}`);
    },
    prune: async (targetIds) => {
      prunedWith.push([...targetIds].sort());
      record("prune");
    },
    clear: async () => {
      record("clear");
    },
  };
};
