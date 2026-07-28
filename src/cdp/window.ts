import { map, type Result } from "../util/result";
import type { CdpError } from "./errors";
import type { CdpSession } from "./session";

export const getWindowId = async (
  session: CdpSession,
  targetId: string,
): Promise<Result<number, CdpError>> =>
  map(await session.callBrowser("Browser.getWindowForTarget", { targetId }), (d) => d.windowId);
