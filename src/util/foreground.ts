import type { BrowserClient } from "../client";
import { neverActivate, POLICY_OFF_HINT } from "./activation";
import type { ToolErr } from "./tool";

// What a tool needs from the screen, measured against Chrome rather than assumed:
//   "rendered"  its trusted pointer input only lands on a tab Chrome is painting. On a hidden tab a
//               mouse move or wheel never answers, and a scroll gesture reports success having scrolled nothing.
//   "raises"    it presses a mouse button, and Chrome raises its window when a press reaches a page.
// A tool that declares neither works on a background tab: script, the accessibility tree, navigation
// and key events all do.
export type ToolForeground = "rendered" | "raises";

const VISIBILITY_PROBE_MS = 2_000;

// undefined when the page did not say (a dialog is open, the tab is gone): the caller must not guess.
export const tabIsHidden = async (client: BrowserClient): Promise<boolean | undefined> => {
  const r = await client.evaluateJs("document.visibilityState", undefined, { timeoutMs: VISIBILITY_PROBE_MS });
  if (!r.success || typeof r.data !== "string") return undefined;
  return r.data === "hidden";
};

// Under the policy, a tool that cannot do its work without activation is refused before it sends
// anything, so the page never receives half an interaction and the model is never told input landed
// when Chrome dropped it.
export const foregroundRefusal = async (
  toolName: string,
  foreground: ToolForeground | undefined,
  client: BrowserClient,
): Promise<ToolErr | undefined> => {
  if (foreground === undefined || !neverActivate()) return undefined;
  if (foreground === "raises") {
    return {
      kind: "policy",
      message:
        `${toolName} presses a real mouse button, which makes the browser raise its window, and the never-activate policy is on. ` +
        `Nothing was sent to the page. To act on the element without raising the browser, call it from script with browser_execute_js ` +
        `(for example element.click()); that is not trusted input and some pages ignore it. To allow the real click, ${POLICY_OFF_HINT}.`,
    };
  }
  if ((await tabIsHidden(client)) !== true) return undefined;
  return {
    kind: "policy",
    message:
      `${toolName} needs this tab on screen: the tab is in the background, where Chrome drops trusted pointer input, ` +
      `and the never-activate policy stops the harness from bringing it forward. Nothing was sent to the page. ` +
      `Scroll from script with browser_execute_js (window.scrollBy, element.scrollIntoView), which is not trusted wheel input, ` +
      `bring the tab forward yourself, or ${POLICY_OFF_HINT}.`,
  };
};

// A timeout on a background tab is usually Chrome waiting for a frame it will never paint. Say so,
// rather than leave a bare timeout that reads like a slow page.
export const explainTimeoutUnderPolicy = async (error: ToolErr, client: BrowserClient): Promise<ToolErr> => {
  if (error.kind !== "timeout" || !neverActivate()) return error;
  if ((await tabIsHidden(client)) !== true) return error;
  return {
    ...error,
    message:
      `${error.message}. This tab is in the background and the never-activate policy keeps it there; Chrome does not paint a background tab, ` +
      `so a call that waits for a frame (a screenshot of a tab that was never shown, trusted pointer input) does not finish. ` +
      `Read the page with browser_snapshot or browser_read_page instead, bring the tab forward yourself, or ${POLICY_OFF_HINT}.`,
  };
};
