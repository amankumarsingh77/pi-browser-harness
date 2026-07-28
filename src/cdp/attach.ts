import { map, type Result } from "../util/result";
import type { CdpError } from "./errors";
import type { CdpSession } from "./session";

export const attachTo = async (
  session: CdpSession,
  targetId: string,
): Promise<Result<string, CdpError>> =>
  map(
    await session.callBrowser("Target.attachToTarget", { targetId, flatten: true }),
    (d) => d.sessionId,
  );
