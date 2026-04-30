/**
 * Tool registrations for pi-browser-harness.
 *
 * Maps browser-harness daemon methods to pi tools with TypeBox schemas,
 * prompt snippets, guidelines, and TUI renderers.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDaemon } from "./daemon";
import type { TabInfo } from "./protocol";

// ── AsyncFunction constructor ────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

// ── Key code map ─────────────────────────────────────────────────────────────

const SPECIAL_KEYS = [
  "Enter", "Tab", "Backspace", "Escape", "Delete",
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", " ",
];

// ── Screenshot path ──────────────────────────────────────────────────────────

let screenshotCounter = 0;
function nextScreenshotPath(): string {
  screenshotCounter++;
  return join(tmpdir(), `pi-browser-screenshot-${Date.now()}-${screenshotCounter}.png`);
}

// ── Output truncation ────────────────────────────────────────────────────────

/** Track temp directories for cleanup on session shutdown. */
const tempDirs: string[] = [];

/** Best-effort cleanup of all tracked temp directories. */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  );
}

/**
 * Truncate output to pi's built-in limits (50KB / 2000 lines).
 * When truncated, writes the full output to a temp file so the LLM
 * can read it via the read tool and so CTRL+O expand can show it.
 */
async function applyTruncation(
  output: string,
  prefix: string,
): Promise<{
  text: string;
  fullOutputPath?: string;
  wasTruncated: boolean;
}> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, wasTruncated: false };
  }

  const tempDir = await mkdtemp(join(tmpdir(), `pi-bh-${prefix}-`));
  tempDirs.push(tempDir);

  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, output, "utf8");
  });

  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  let text = truncation.content;
  text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${formatSize(omittedBytes)} omitted. Full output: ${tempFile}]`;

  return { text, fullOutputPath: tempFile, wasTruncated: true };
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerTools(pi: ExtensionAPI, daemon: BrowserDaemon): void {
  // ═══════════════════════════════════════════════════════════════════════════
  // browser_navigate
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Navigate to a URL. Creates a new tab on first call (safe), navigates current tab on subsequent calls.",
    promptSnippet: "Navigate to a URL (creates new tab on first call)",
    promptGuidelines: [
      "Use browser_navigate to go to URLs. The first call creates a new tab so it doesn't clobber the user's active tab.",
      "Use browser_wait_for_load after browser_navigate to wait for the page to finish loading.",
      "For extracting data from a page you already navigated to, use browser_execute_js or browser_http_get (faster for APIs).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Full URL to navigate to (e.g. https://github.com)" }),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();

        // Determine if we need a new tab: create one on first-ever call,
        // or if the current tab is an internal Chrome page. Otherwise
        // navigate the current tab in-place.
        let targetId: string;
        let isNewTab = false;
        try {
          const tabs = await daemon.listTabs(false);
          if (tabs.length === 0) {
            // No real tabs exist — create one
            targetId = await daemon.newTab(params.url);
            isNewTab = true;
          } else {
            // Navigate the current tab in-place
            await daemon.cdp("Page.navigate", { url: params.url });
            const tab = await daemon.currentTab();
            targetId = tab.targetId;
          }
        } catch {
          // Fallback: create a new tab
          targetId = await daemon.newTab(params.url);
          isNewTab = true;
        }

        const info = await daemon.getPageInfo();
        if ("dialog" in info) {
          return {
            content: [{ type: "text" as const, text: `Navigated to ${params.url}\nTarget: ${targetId}\n⚠️  A dialog is open: ${info.dialog.type} — "${info.dialog.message}"\nUse browser_handle_dialog to dismiss or accept it.` }],
            details: undefined,
          };
        }

        const prefix = isNewTab ? "New tab: " : "";
        return {
          content: [{
            type: "text" as const,
            text: `${prefix}Navigated to: ${info.url}\nTitle: ${info.title}\nViewport: ${info.width}x${info.height}\nTarget: ${targetId}`,
          }],
          details: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderCall(args, theme) {
      return new Text(`🌐 Navigate to ${(args as { url: string }).url}`, 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_page_info
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_page_info",
    label: "Browser Page Info",
    description:
      "Get current page state: URL, title, viewport size, scroll position, page dimensions. If a JS dialog (alert/confirm/prompt) is open, returns dialog info instead.",
    promptSnippet: "Get current page URL, title, viewport, and scroll position",
    promptGuidelines: [
      "Use browser_page_info to quickly check what page you're on and whether a JS dialog is blocking interaction.",
      "If browser_page_info returns a dialog, use browser_handle_dialog before any other browser actions.",
    ],
    parameters: Type.Object({}),
    async execute() {
      try {
        await daemon.ensureAlive();
        const info = await daemon.getPageInfo();

        if ("dialog" in info) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️  DIALOG OPEN: ${info.dialog.type}\nMessage: ${info.dialog.message}${info.dialog.defaultPrompt ? `\nDefault: ${info.dialog.defaultPrompt}` : ""}\n\nUse browser_handle_dialog to accept or dismiss.`,
            }],
            details: undefined,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `URL: ${info.url}\nTitle: ${info.title}\nViewport: ${info.width}x${info.height}\nScroll: (${info.scrollX}, ${info.scrollY})\nPage size: ${info.pageWidth}x${info.pageHeight}`,
          }],
          details: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_go_back
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_go_back",
    label: "Browser Go Back",
    description: "Navigate back one page in history.",
    promptSnippet: "Go back one page in browser history",
    promptGuidelines: [
      "Use browser_go_back to return to the previous page after navigating.",
    ],
    parameters: Type.Object({}),
    async execute() {
      try {
        await daemon.ensureAlive();
        const history = (await daemon.cdp("Page.getNavigationHistory")) as {
          entries: Array<{ id: number; url: string; title: string }>;
          currentIndex: number;
        };
        if (history.currentIndex <= 0) {
          return { content: [{ type: "text" as const, text: "Already at the beginning of history." }], details: undefined };
        }
        const targetEntry = history.entries[history.currentIndex - 1];
        await daemon.cdp("Page.navigateToHistoryEntry", { entryId: targetEntry.id });
        return { content: [{ type: "text" as const, text: `Navigated back to: ${targetEntry.url}` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_go_forward
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_go_forward",
    label: "Browser Go Forward",
    description: "Navigate forward one page in history.",
    promptSnippet: "Go forward one page in browser history",
    promptGuidelines: [
      "Use browser_go_forward to go forward after navigating back.",
    ],
    parameters: Type.Object({}),
    async execute() {
      try {
        await daemon.ensureAlive();
        const history = (await daemon.cdp("Page.getNavigationHistory")) as {
          entries: Array<{ id: number; url: string; title: string }>;
          currentIndex: number;
        };
        if (history.currentIndex >= history.entries.length - 1) {
          return { content: [{ type: "text" as const, text: "Already at the end of history." }], details: undefined };
        }
        const targetEntry = history.entries[history.currentIndex + 1];
        await daemon.cdp("Page.navigateToHistoryEntry", { entryId: targetEntry.id });
        return { content: [{ type: "text" as const, text: `Navigated forward to: ${targetEntry.url}` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_reload
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page.",
    promptSnippet: "Reload the current page",
    promptGuidelines: [
      "Use browser_reload to refresh the current page, e.g. after making changes that should be reflected.",
    ],
    parameters: Type.Object({}),
    async execute() {
      try {
        await daemon.ensureAlive();
        await daemon.cdp("Page.reload");
        const info = await daemon.getPageInfo();
        if ("dialog" in info) {
          return { content: [{ type: "text" as const, text: `Reloaded. ⚠️ Dialog open: ${info.dialog.type}` }], details: undefined };
        }
        return { content: [{ type: "text" as const, text: `Reloaded: ${info.title} (${info.url})` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_click
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click at viewport CSS-pixel coordinates. Compositor-level click works through iframes, shadow DOM, and cross-origin content. Use browser_screenshot first to find coordinates.",
    promptSnippet: "Click at pixel coordinates (x, y) on the page",
    promptGuidelines: [
      "Use browser_click for all clicks. Coordinates are viewport CSS pixels (not device pixels).",
      "Capture a browser_screenshot BEFORE clicking to find the right coordinates.",
      "Capture another browser_screenshot AFTER clicking to verify the action worked.",
      "Compositor-level clicks pass through iframes, shadow DOM, and cross-origin content — no selector needed.",
    ],
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate in CSS pixels from left edge of viewport" }),
      y: Type.Number({ description: "Y coordinate in CSS pixels from top edge of viewport" }),
      button: Type.Optional(Type.String({ description: 'Mouse button: "left", "right", or "middle". Default: "left"' })),
      clicks: Type.Optional(Type.Number({ description: "Number of clicks (1 = single, 2 = double). Default: 1" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        await daemon.cdp("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: params.x,
          y: params.y,
          button: params.button || "left",
          clickCount: params.clicks || 1,
        });
        await daemon.cdp("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: params.x,
          y: params.y,
          button: params.button || "left",
          clickCount: params.clicks || 1,
        });
        return { content: [{ type: "text" as const, text: `Clicked at (${params.x}, ${params.y})` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Click failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderCall(args, theme) {
      const { x, y } = args as { x: number; y: number };
      return new Text(`🖱️ Click at (${x}, ${y})`, 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_type
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into the currently focused element. Use browser_click first to focus an input field.",
    promptSnippet: "Type text into the focused element",
    promptGuidelines: [
      "Use browser_type to enter text. Click on an input field with browser_click first to focus it.",
      "For special keys (Enter, Tab, Escape, arrows), use browser_press_key instead.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        await daemon.cdp("Input.insertText", { text: params.text });
        return { content: [{ type: "text" as const, text: `Typed: "${params.text}"` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Type failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_press_key
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_press_key",
    label: "Browser Press Key",
    description:
      "Press a keyboard key. Supports special keys (Enter, Tab, Backspace, Escape, Delete, arrows, Home, End, PageUp, PageDown, Space as ' ') and regular characters. Optional modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift.",
    promptSnippet: "Press a key (Enter, Tab, Escape, arrows, or any character)",
    promptGuidelines: [
      "Use browser_press_key for keyboard shortcuts and navigation keys.",
      "Special key names: Enter, Tab, Backspace, Escape, Delete, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown.",
      "Use Space as ' ' (a single space character).",
      "Modifiers: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift. Combine with bitwise OR: Ctrl+Shift = 2|8 = 10.",
    ],
    parameters: Type.Object({
      key: Type.String({ description: 'Key to press. Special keys: Enter, Tab, Backspace, Escape, Delete, ArrowLeft/Up/Right/Down, Home, End, PageUp, PageDown. Space as " "' }),
      modifiers: Type.Optional(Type.Number({ description: "Modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift. Combine with OR." })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const k = params.key;
        const mod = params.modifiers || 0;
        const vk = daemon.getVirtualKeyCode(k);
        const code = daemon.getKeyCode(k);
        const isSpecial = SPECIAL_KEYS.includes(k);
        const text = k.length === 1 && !isSpecial ? k : "";

        // keyDown
        const base = {
          type: "keyDown" as const,
          key: k,
          code,
          modifiers: mod,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          ...(text ? { text } : {}),
        };
        await daemon.cdp("Input.dispatchKeyEvent", base);

        // char event for printable single characters
        if (text.length === 1) {
          await daemon.cdp("Input.dispatchKeyEvent", {
            type: "char",
            text,
            key: k,
            code,
            modifiers: mod,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
          });
        }

        // keyUp
        await daemon.cdp("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: k,
          code,
          modifiers: mod,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });

        return { content: [{ type: "text" as const, text: `Pressed: "${k}"${mod ? ` (modifiers: ${mod})` : ""}` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Key press failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_scroll
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description:
      "Scroll the page at given coordinates (or center of viewport if not specified). Default scrolls down 300px.",
    promptSnippet: "Scroll the page by deltaY/deltaX pixels at coordinates",
    promptGuidelines: [
      "Use browser_scroll to scroll pages. Default deltaY=-300 scrolls down.",
      "Positive deltaY scrolls up, negative scrolls down.",
      "Capture browser_screenshot after scrolling to see the new viewport content.",
    ],
    parameters: Type.Object({
      deltaY: Type.Optional(Type.Number({ description: "Vertical scroll delta in pixels. Negative = down, positive = up. Default: -300" })),
      deltaX: Type.Optional(Type.Number({ description: "Horizontal scroll delta in pixels. Default: 0" })),
      x: Type.Optional(Type.Number({ description: "X position to scroll from. Default: viewport center" })),
      y: Type.Optional(Type.Number({ description: "Y position to scroll from. Default: viewport center" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const dy = params.deltaY ?? -300;
        const dx = params.deltaX ?? 0;

        // Default to center of viewport if not specified
        let cx = params.x;
        let cy = params.y;
        if (cx === undefined || cy === undefined) {
          try {
            const info = await daemon.getPageInfo();
            if (!("dialog" in info)) {
              if (cx === undefined) cx = Math.round(info.width / 2);
              if (cy === undefined) cy = Math.round(info.height / 2);
            }
          } catch {
            cx = cx ?? 500;
            cy = cy ?? 400;
          }
        }

        await daemon.cdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: cx,
          y: cy,
          deltaX: dx,
          deltaY: dy,
        });

        return { content: [{ type: "text" as const, text: `Scrolled by (${dx}, ${dy}) at (${cx}, ${cy})` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Scroll failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_screenshot
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Capture a PNG screenshot of the current page. Use this BEFORE interactions to find targets, and AFTER to verify results. This is the primary visual feedback mechanism.",
    promptSnippet: "Capture a screenshot of the current page (PNG)",
    promptGuidelines: [
      "Use browser_screenshot as your FIRST step when exploring a page — it shows you what's visible.",
      "After every browser_click, browser_type, browser_scroll, or browser_navigate, capture a screenshot to VERIFY the action worked.",
      "Screenshots are the fastest way to find click targets, notice hidden blockers, and decide next steps.",
      "Never assume an action worked. Always re-screenshot to confirm.",
    ],
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page (not just viewport). Default: false" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const path = nextScreenshotPath();
        await daemon.captureScreenshot(path, params.fullPage === true);
        return {
          content: [{ type: "text" as const, text: `Screenshot saved: ${path}${params.fullPage ? " (full page)" : ""}` }],
          details: { path },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderCall(_, theme) {
      return new Text(`📸 Capturing screenshot...`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const path = (result.details as { path?: string })?.path;
      return new Text(path ? `📸 Screenshot: ${path}` : `📸 Screenshot captured`, 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_list_tabs
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_list_tabs",
    label: "Browser List Tabs",
    description: "List all open browser tabs.",
    promptSnippet: "List all open browser tabs with URLs and titles",
    promptGuidelines: [
      "Use browser_list_tabs to see what tabs are open before switching.",
      "Use browser_switch_tab to switch to a specific tab by targetId.",
      "Set includeChrome: true to also see Chrome internal pages (devtools, settings, etc).",
    ],
    parameters: Type.Object({
      includeChrome: Type.Optional(Type.Boolean({ description: "Include Chrome internal pages (chrome://, devtools://, etc). Default: true" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const tabs = await daemon.listTabs(params.includeChrome !== false);
        const listing = tabs
          .map((t, i) => `[${i}] ${t.title || "(no title)"}\n    URL: ${t.url}\n    ID: ${t.targetId}`)
          .join("\n\n");
        return {
          content: [{ type: "text" as const, text: `${tabs.length} tab(s):\n\n${listing}` }],
          details: { tabs },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        tabs?: TabInfo[];
        fullOutputPath?: string;
      } | undefined;

      const tabCount = details?.tabs?.length ?? 0;

      if (expanded) {
        // Expanded (CTRL+O): show full tab listing
        const content = result.content[0];
        const raw = content?.type === "text" ? content.text : "";
        return new Text(raw || "(no tabs)", 0, 0);
      }

      // Collapsed (default): compact count
      return new Text(
        theme ? theme.fg("dim", `📋 ${tabCount} tab${tabCount !== 1 ? "s" : ""}`) : `📋 ${tabCount} tab${tabCount !== 1 ? "s" : ""}`,
        0,
        0,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_current_tab
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_current_tab",
    label: "Browser Current Tab",
    description: "Get info about the currently active tab.",
    promptSnippet: "Get the current active tab's URL, title, and ID",
    promptGuidelines: [
      "Use browser_current_tab to confirm which tab you're controlling.",
    ],
    parameters: Type.Object({}),
    async execute() {
      try {
        await daemon.ensureAlive();
        const tab = await daemon.currentTab();
        return {
          content: [{ type: "text" as const, text: `Current tab: ${tab.title || "(no title)"}\nURL: ${tab.url}\nID: ${tab.targetId}` }],
          details: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_switch_tab
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_switch_tab",
    label: "Browser Switch Tab",
    description: "Switch to a different browser tab by targetId (from browser_list_tabs).",
    promptSnippet: "Switch to a browser tab by its targetId",
    promptGuidelines: [
      "Use browser_list_tabs first to find the targetId, then browser_switch_tab to switch.",
    ],
    parameters: Type.Object({
      targetId: Type.String({ description: "Target ID of the tab to switch to (from browser_list_tabs)" }),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        await daemon.switchTab(params.targetId);
        const tab = await daemon.currentTab();
        return {
          content: [{ type: "text" as const, text: `Switched to: ${tab.title || "(no title)"}\nURL: ${tab.url}` }],
          details: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Switch failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_new_tab
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_new_tab",
    label: "Browser New Tab",
    description: "Open a new browser tab and switch to it. Optionally navigate to a URL.",
    promptSnippet: "Open a new browser tab, optionally navigate to a URL",
    promptGuidelines: [
      "Use browser_new_tab for the first navigation in a task — it preserves the user's active tab.",
      "Use browser_navigate for subsequent navigation in the same tab.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to navigate to in the new tab. Default: about:blank" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const targetId = await daemon.newTab(params.url);
        const msg = params.url
          ? `New tab created and navigated to: ${params.url}\nTarget: ${targetId}`
          : `New tab created: about:blank\nTarget: ${targetId}`;
        return { content: [{ type: "text" as const, text: msg }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_execute_js
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_execute_js",
    label: "Browser Execute JS",
    description:
      'Execute JavaScript in the current page and return the result. Use for data extraction, DOM inspection, and page manipulation. Expressions with "return" are automatically wrapped in an IIFE.',
    promptSnippet: "Execute JavaScript in the page and return the result",
    promptGuidelines: [
      "Use browser_execute_js for extracting structured data from the page (text, attributes, JSON from embedded scripts).",
      "Use browser_execute_js for DOM inspection when coordinates from screenshots aren't sufficient.",
      "For bulk data extraction, prefer browser_http_get for API calls — it's 10-50x faster than browser DOM scraping.",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "JavaScript expression to evaluate. 'return' statements are auto-wrapped in IIFE." }),
      targetId: Type.Optional(Type.String({ description: "Target ID of an iframe to evaluate in (optional)" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const value = await daemon.evaluateJS(params.expression, params.targetId);
        const raw = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
        const { text, fullOutputPath } = await applyTruncation(raw, "js");
        return {
          content: [{ type: "text" as const, text }],
          details: { valueLength: raw.length, fullOutputPath },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `JS execution failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        valueLength?: number;
        fullOutputPath?: string;
      } | undefined;

      const len = details?.valueLength ?? 0;

      if (expanded) {
        // Expanded (CTRL+O): show the full JS result
        const content = result.content[0];
        const raw = content?.type === "text" ? content.text : "";
        return new Text(raw || "undefined", 0, 0);
      }

      // Collapsed (default): size + first-line preview
      const content = result.content[0];
      const raw = content?.type === "text" ? content.text : "";
      const firstLine = raw.split("\n")[0] || "";
      const preview =
        firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;

      const summary = `📜 JS result (${formatSize(len)})`;
      return new Text(
        theme
          ? theme.fg("dim", summary) + "\n" + theme.fg("muted", preview)
          : summary + "\n" + preview,
        0,
        0,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_http_get
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_http_get",
    label: "Browser HTTP GET",
    description:
      "Make a direct HTTP GET request (no browser). Use for APIs and static pages — much faster than browser navigation for data retrieval.",
    promptSnippet: "Make a direct HTTP GET request (outside browser, for APIs)",
    promptGuidelines: [
      "Use browser_http_get for API calls and static page retrieval — it bypasses the browser entirely and is 10-50x faster.",
      "Use browser_http_get with ThreadPoolExecutor for bulk data retrieval from multiple URLs.",
      "Do NOT use browser_http_get for pages that require JavaScript rendering — use browser_navigate + browser_execute_js instead.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional HTTP headers" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Default: 20" })),
    }),
    async execute(_id, params) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), (params.timeout || 20) * 1000);

        const response = await fetch(params.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Accept: "text/html,application/json,*/*",
            ...params.headers,
          },
          signal: controller.signal,
        });

        clearTimeout(timer);

        const body = await response.text();
        const contentType = response.headers.get("content-type") || "unknown";

        // Build header (always shown) and truncate body separately
        const headerText = `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\nLength: ${body.length} chars\n\n`;
        const { text: truncatedBody, fullOutputPath, wasTruncated } = await applyTruncation(
          body,
          "http",
        );

        return {
          content: [{
            type: "text" as const,
            text: headerText + truncatedBody,
          }],
          details: {
            status: response.status,
            contentType,
            length: body.length,
            fullOutputPath,
            wasTruncated,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `HTTP request failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        status?: number;
        contentType?: string;
        length?: number;
        wasTruncated?: boolean;
        fullOutputPath?: string;
      } | undefined;

      const status = details?.status ?? 0;
      const ct = details?.contentType ?? "unknown";
      const len = details?.length ?? 0;
      const wasTruncated = details?.wasTruncated ?? false;

      if (expanded) {
        // Expanded (CTRL+O): show full response body
        const content = result.content[0];
        const raw = content?.type === "text" ? content.text : "";
        return new Text(raw || "(empty response)", 0, 0);
      }

      // Collapsed (default): compact HTTP response summary
      const shortCt = ct.split(";")[0] || ct; // drop charset etc.
      const truncNote = wasTruncated ? " (truncated)" : "";
      const summary = `🌐 HTTP ${status}, ${shortCt}, ${formatSize(len)}${truncNote}`;

      return new Text(
        theme
          ? theme.fg(status >= 200 && status < 300 ? "success" : status >= 400 ? "error" : "warning", summary)
          : summary,
        0,
        0,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_wait
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for a specified number of seconds.",
    promptSnippet: "Wait for N seconds (default 1s)",
    promptGuidelines: [
      "Use browser_wait for simple delays. Prefer browser_wait_for_load after navigation.",
    ],
    parameters: Type.Object({
      seconds: Type.Optional(Type.Number({ description: "Seconds to wait. Default: 1" })),
    }),
    async execute(_id, params) {
      const sec = params.seconds || 1;
      await new Promise((r) => setTimeout(r, sec * 1000));
      return { content: [{ type: "text" as const, text: `Waited ${sec}s.` }], details: undefined };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_wait_for_load
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_wait_for_load",
    label: "Browser Wait For Load",
    description:
      "Wait for the page to finish loading (document.readyState === 'complete'). Returns false on timeout. Note: SPAs may need additional waiting after this.",
    promptSnippet: "Wait for document.readyState === 'complete'",
    promptGuidelines: [
      "Use browser_wait_for_load after browser_navigate or browser_new_tab.",
      "This checks document.readyState only. Single-page apps may still be loading data after this returns true.",
      "For SPAs, use browser_execute_js to check for specific elements after browser_wait_for_load.",
    ],
    parameters: Type.Object({
      timeout: Type.Optional(Type.Number({ description: "Max seconds to wait. Default: 15" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const timeout = params.timeout || 15;
        const deadline = Date.now() + timeout * 1000;

        while (Date.now() < deadline) {
          const state = await daemon.evaluateJS("document.readyState");
          if (state === "complete") {
            return { content: [{ type: "text" as const, text: "Page loaded (readyState: complete)." }], details: undefined };
          }
          await new Promise((r) => setTimeout(r, 300));
        }

        return {
          isError: true,
          content: [{ type: "text" as const, text: `Page load timed out after ${timeout}s. Current state unknown.` }],
          details: undefined,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Wait failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_handle_dialog
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_handle_dialog",
    label: "Browser Handle Dialog",
    description:
      "Handle a JavaScript dialog (alert, confirm, prompt, beforeunload). Use when browser_page_info reports an open dialog.",
    promptSnippet: "Accept or dismiss a JavaScript dialog (alert/confirm/prompt)",
    promptGuidelines: [
      "Check browser_page_info first — if it returns a dialog, use browser_handle_dialog before any other browser actions.",
      "JS dialogs freeze the page's JS thread, so no other interaction works until the dialog is handled.",
      'Use action: "accept" for alerts and confirms, "dismiss" to cancel. For prompts, provide promptText.',
    ],
    parameters: Type.Object({
      action: Type.String({ description: '"accept" or "dismiss"' }),
      promptText: Type.Optional(Type.String({ description: 'Text to enter for prompt dialogs (only used with "accept")' })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();

        if (params.action === "accept") {
          await daemon.cdp("Page.handleJavaScriptDialog", {
            accept: true,
            ...(params.promptText !== undefined ? { promptText: params.promptText } : {}),
          });
        } else {
          await daemon.cdp("Page.handleJavaScriptDialog", { accept: false });
        }

        return { content: [{ type: "text" as const, text: `Dialog ${params.action}ed.` }], details: undefined };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Dialog handling failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_open_urls
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_open_urls",
    label: "Browser Open URLs",
    description:
      "Open multiple URLs in new browser tabs in parallel. Useful after web_search to open citation links for visual inspection. Creates real Chrome tabs with full JS rendering support — identical to browser_new_tab but for many URLs at once.",
    promptSnippet: "Open multiple URLs in new tabs (parallel, full JS rendering)",
    promptGuidelines: [
      "Use browser_open_urls to open multiple URLs in parallel — much faster than calling browser_new_tab repeatedly.",
      "Use browser_open_urls after web_search to open citation links from the synthesized answer.",
      "Each URL opens in a real Chrome tab with full JS rendering — same as browser_new_tab.",
      "After opening, use browser_list_tabs to see all tabs, browser_switch_tab to switch, and browser_screenshot / browser_execute_js to interact.",
      "Use browser_wait_for_load on a tab before extracting data from SPAs.",
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "Array of URLs to open in new tabs" }),
    }),
    async execute(_id, params, _signal, onUpdate) {
      await daemon.ensureAlive();

      const total = params.urls.length;
      const results: Array<{
        url: string;
        targetId: string;
        ok: boolean;
        error?: string;
      }> = [];

      // ═══════════════════════════════════════════════════════════════════
      // Phase 1: Create all tabs in parallel.
      // Target.createTarget is a browser-level CDP call — no session
      // needed, no shared state mutated. Safe to parallelize.
      // ═══════════════════════════════════════════════════════════════════
      const createPromises = params.urls.map(async (url: string) => {
        try {
          const result = (await daemon.cdp("Target.createTarget", {
            url: "about:blank",
          })) as { targetId: string };
          return { url, targetId: result.targetId, ok: true as const };
        } catch (err) {
          return {
            url,
            targetId: "",
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
            details: undefined,
          };
        }
      });

      const created = await Promise.all(createPromises);

      // ═══════════════════════════════════════════════════════════════════
      // Phase 2: Attach a CDP session to each tab and navigate.
      // Each tab gets its own sessionId passed explicitly to cdp(),
      // avoiding the shared daemon._sessionId. Safe to parallelize.
      // ═══════════════════════════════════════════════════════════════════
      let completed = 0;
      const attachAndNav = created
        .filter((t) => t.ok)
        .map(async (tab) => {
          try {
            // Attach to target to get a session for this tab
            const attachResult = (await daemon.cdp(
              "Target.attachToTarget",
              { targetId: tab.targetId, flatten: true },
            )) as { sessionId: string };
            const sid = attachResult.sessionId;

            // Enable the Page domain so navigation events fire
            await daemon.cdp("Page.enable", {}, sid);

            // Navigate to the URL using the tab's own session
            await daemon.cdp("Page.navigate", { url: tab.url }, sid);

            return { ...tab, ok: true as const, targetId: tab.targetId };
          } catch (err) {
            return {
              ...tab,
              ok: false as const,
              error: err instanceof Error ? err.message : String(err),
              details: undefined,
            };
          } finally {
            completed++;
            // Stream progress so the TUI shows live per-URL status
            const okCount = created.filter((t) => t.ok).length;
            onUpdate?.({
              content: [
                {
                  type: "text" as const,
                  text: `Opening URLs… ${completed}/${okCount} navigated`,
                },
              ],
              details: undefined,
            });
          }
        });

      // Also collect failures from Phase 1
      const failures = created.filter((t) => !t.ok);

      const settled = await Promise.all(attachAndNav);
      results.push(...settled, ...failures);

      // ═══════════════════════════════════════════════════════════════════
      // Phase 3: Activate the last successfully opened tab so the user
      // sees something meaningful in the foreground.
      // ═══════════════════════════════════════════════════════════════════
      const lastOk = [...settled].reverse().find((r) => r.ok);
      if (lastOk) {
        try {
          await daemon.cdp("Target.activateTarget", {
            targetId: lastOk.targetId,
          });
        } catch {
          // best-effort — the tabs are still open
        }
      }

      // Build result text
      const okTabs = results.filter((r) => r.ok);
      const failedTabs = results.filter((r) => !r.ok);

      const lines: string[] = [];
      if (okTabs.length > 0) {
        lines.push(
          `✅ ${okTabs.length}/${total} tabs opened:`,
          ...okTabs.map(
            (t, i) => `  [${i}] ${t.url} → ${t.targetId}`,
          ),
        );
      }
      if (failedTabs.length > 0) {
        lines.push(
          `❌ ${failedTabs.length}/${total} failed:`,
          ...failedTabs.map(
            (t) => `  ${t.url}: ${t.error || "unknown error"}`,
          ),
        );
      }

      const isTotalFailure = okTabs.length === 0;
      const fullOutput = lines.join("\n");
      const { text, fullOutputPath } = await applyTruncation(fullOutput, "urls");

      return {
        isError: isTotalFailure,
        content: [{ type: "text" as const, text }],
        details: { tabs: results, fullOutputPath },
      };
    },
    renderCall(args, _theme) {
      const { urls } = args as { urls: string[] };
      return new Text(
        `🌐 Opening ${urls.length} URL${urls.length !== 1 ? "s" : ""}…`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        tabs?: Array<{
          url: string;
          targetId: string;
          ok: boolean;
          error?: string;
        }>;
        fullOutputPath?: string;
      } | undefined;

      const tabs = details?.tabs || [];
      const ok = tabs.filter((t) => t.ok).length;
      const fail = tabs.filter((t) => !t.ok).length;
      const total = tabs.length;

      if (expanded) {
        // Expanded (CTRL+O): show the full URL→targetId mapping
        const content = result.content[0];
        const raw = content?.type === "text" ? content.text : "";
        // Strip the truncation footer for cleaner display, show it separately
        const truncIdx = raw.indexOf("\n\n[Output truncated:");
        const displayText = truncIdx >= 0 ? raw.slice(0, truncIdx) : raw;

        let expandedText = displayText || "(no output)";
        if (details?.fullOutputPath && truncIdx < 0) {
          // Truncated but we stripped the footer — add a compact note
          expandedText += `\n\n${theme ? theme.fg("dim", `Full output: ${details.fullOutputPath}`) : `Full output: ${details.fullOutputPath}`}`;
        } else if (details?.fullOutputPath) {
          expandedText += `\n${theme ? theme.fg("dim", `Full output: ${details.fullOutputPath}`) : `Full output: ${details.fullOutputPath}`}`;
        }
        return new Text(expandedText, 0, 0);
      }

      // Collapsed (default): compact summary
      let text: string;
      if (total === 0) {
        text = "No URLs provided.";
      } else if (fail === 0) {
        text = `✅ ${ok} tab${ok !== 1 ? "s" : ""} opened`;
      } else if (ok === 0) {
        text = `❌ All ${fail} URL${fail !== 1 ? "s" : ""} failed`;
      } else {
        text = `⚠️ ${ok} opened, ${fail} failed`;
      }

      return new Text(
        theme ? theme.fg(fail === 0 ? "success" : ok === 0 ? "error" : "warning", text) : text,
        0,
        0,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_run_script
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_run_script",
    label: "Browser Run Script",
    description:
      "Execute a temporary JavaScript script file with access to the browser daemon " +
      "and Node.js APIs. Use this when the built-in browser_* tools are insufficient " +
      "for a multi-step workflow — write a script to disk, then run it with this tool. " +
      "The script receives these bindings in scope:\n" +
      "  params    — the arguments passed to this tool\n" +
      "  daemon    — the browser daemon (daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc.)\n" +
      "  require   — Node.js require() for builtins and installed packages\n" +
      "  signal    — AbortSignal for cancellation\n" +
      "  onUpdate  — progress callback: onUpdate({ content: [{ type: 'text', text: '...' }] })\n" +
      "  ctx       — ExtensionContext with cwd, sessionManager, ui, signal, etc.\n" +
      "  console, fetch, JSON, Buffer, setTimeout, clearTimeout\n\n" +
      "The script MUST return { content: [{ type: 'text', text: '...' }], details?: {...} }.\n" +
      "For errors, throw: throw new Error('something went wrong').",
    promptSnippet: "Run a temporary script with browser daemon access (write script to disk first)",
    promptGuidelines: [
      "Use write to create a temporary script file, then browser_run_script to execute it — no dynamic tool registration needed.",
      "Scripts are written to disk, making them auditable and re-runnable. The user can inspect them.",
      "The script has access to the browser daemon via `daemon` — use daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc.",
      "For pure data processing or file operations, use require() to access Node.js modules like fs, path, crypto.",
      "If the script only needs built-in browser_* tools, break those into separate tool calls before or after — do not try to invoke them from within the script.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the temporary script file (.js or .mjs) to execute" }),
      params: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional parameters to pass to the script as `params`" })),
    }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const { path: scriptPath, params: scriptParams } = p as {
        path: string;
        params?: Record<string, unknown>;
      };

      // ── Read the script from disk ────────────────────────────────────
      let source: string;
      try {
        source = await readFile(scriptPath, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Failed to read script: ${msg}\n\nPath: ${scriptPath}\nCheck that the file exists and is readable.`,
          }],
          details: { error: "read_failed", message: msg },
        };
      }

      if (source.trim().length === 0) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Script is empty: ${scriptPath}` }],
          details: { error: "empty_script" },
        };
      }

      // ── Compile ─────────────────────────────────────────────────────
      let executeFn: (...args: unknown[]) => Promise<unknown>;
      try {
        const wrapped = `"use strict";\n${source}`;
        executeFn = new AsyncFunction(
          "params", "daemon", "require", "signal", "onUpdate", "ctx",
          "console", "fetch", "JSON", "Buffer", "setTimeout", "clearTimeout",
          wrapped,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Syntax error in script: ${msg}\n\nFile: ${scriptPath}\nFix the JavaScript syntax and try again.`,
          }],
          details: { error: "syntax_error", message: msg },
        };
      }

      // ── Execute ─────────────────────────────────────────────────────
      try {
        const result = await executeFn(
          scriptParams ?? {},
          daemon,
          require,
          signal,
          onUpdate ?? ((_update: unknown) => {}),
          ctx ?? { cwd: process.cwd() },
          console,
          fetch,
          JSON,
          Buffer,
          setTimeout,
          clearTimeout,
        );

        if (!result || typeof result !== "object" || !Array.isArray((result as any).content)) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Script must return { content: [{ type: 'text', text: '...' }], details?: {...} }.\nGot: ${JSON.stringify(result)}\n\nFile: ${scriptPath}`,
            }],
            details: { error: "invalid_return" },
          };
        }

        return result as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Script execution failed: ${msg}\n\nFile: ${scriptPath}\nCheck for runtime errors, undefined variables, or broken require() calls.`,
          }],
          details: { error: "execution_failed", message: msg },
        };
      }
    },
  });
}
