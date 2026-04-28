/**
 * TUI renderers for pi-browser-harness.
 *
 * Registers custom message renderers and tool renderCall/renderResult
 * for browser tools.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export function registerRenderers(pi: ExtensionAPI): void {
  // Register a message renderer for screenshot notifications
  pi.registerMessageRenderer("browser-screenshot", (message, _options, theme) => {
    const path = (message as { details?: { path?: string } }).details?.path || "unknown";
    return new Text(
      theme.fg("accent", `📸 Screenshot: ${path}`),
      0,
      0,
    );
  });
}
