import { map, type Result, ok } from "../util/result";
import type { CdpError } from "./errors";
import type { CdpSession } from "./session";

export const startScreencastOn = async (
  session: CdpSession,
  sessionId: string,
): Promise<Result<void, CdpError>> =>
  map(
    await session.callOnTarget(
      "Page.startScreencast",
      { format: "jpeg", quality: 80, maxWidth: 1280, maxHeight: 720 },
      sessionId,
    ),
    () => undefined,
  );

// Stopping a screencast on a tab that has already closed is not an error the caller can act on, so a failed call is folded into success.
export const stopScreencastOn = async (
  session: CdpSession,
  sessionId: string,
): Promise<Result<void, CdpError>> => {
  await session.callOnTarget("Page.stopScreencast", {}, sessionId);
  return ok(undefined);
};
