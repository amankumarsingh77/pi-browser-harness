import type { BrowserClient } from "../client";

/**
 * Capture the real Chrome windowId of a freshly-created harness window and bind
 * it as the session's durable window identity. Best-effort: a failed CDP call
 * leaves the previous binding untouched. Call this on every code path that
 * spawns a NEW dedicated window (newWindow:true), so the windowId never points
 * at a window that has since been replaced.
 */
export const bindHarnessWindowId = async (client: BrowserClient, targetId: string): Promise<void> => {
  const r = await client.session().callBrowser("Browser.getWindowForTarget", { targetId });
  if (!r.success) return;
  const wid = (r.data as { windowId?: number }).windowId;
  if (typeof wid === "number") client.ownership().setHarnessWindowId(wid);
};
