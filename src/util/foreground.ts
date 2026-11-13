import type { BrowserClient } from "../client";
import type { CdpError } from "../cdp/errors";
import { type Result, ok } from "./result";
import { neverActivate } from "./activation";

// A tool declares that it needs the tab on screen, measured against Chrome rather than assumed:
//   "rendered"  its trusted pointer input only lands on a tab Chrome is painting. On a hidden tab a
//               mouse move or wheel never answers, and a scroll gesture reports success having scrolled nothing.
//   "raises"    it presses a mouse button, which also needs a painted tab; Chrome raises its window
//               itself when the press arrives.
// A tool that declares neither works on a background tab: script, the accessibility tree, navigation
// and key events all do.
export type ToolForeground = "rendered" | "raises";

const VISIBILITY_PROBE_MS = 2_000;

// undefined when the page did not say (a dialog is open, the tab is gone).
export const tabIsHidden = async (client: BrowserClient): Promise<boolean | undefined> => {
  const r = await client.evaluateJs("document.visibilityState", undefined, { timeoutMs: VISIBILITY_PROBE_MS });
  if (!r.success || typeof r.data !== "string") return undefined;
  return r.data === "hidden";
};

// Background mode never changes what a tool does, only whether the browser comes forward for it.
// With the mode off a switched-to tab is already the one on screen. With it on a tab may be hidden,
// so anything that needs it painted brings it forward first, exactly as it would have been. A tab
// that is already visible is left alone, and one that cannot say is treated as hidden.
export const showTabIfHidden = async (client: BrowserClient): Promise<Result<void, CdpError>> => {
  if (!neverActivate()) return ok(undefined);
  if ((await tabIsHidden(client)) === false) return ok(undefined);
  const front = await client.session().call("Page.bringToFront", {});
  return front.success ? ok(undefined) : front;
};
