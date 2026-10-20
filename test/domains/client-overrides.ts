// Local wrappers for the domain tests in set B. The fake client in ./fake-client.ts routes CDP traffic through a
// scripted transport but leaves the client-level helpers (pageInfo, listTabs, switchTab, newTab, current) as
// "not configured"; the tools under test call those directly, so a test overrides just the members it drives.
// Nothing here edits the fake: a wrapper is a spread of the fake's client with the overridden members on top.
import { deflateSync, crc32 } from "node:zlib";
import { Theme, type ThemeColor, initTheme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../../src/client";
import { type CdpError, cdpError } from "../../src/cdp/errors";
import type { DialogInfo, PageInfo, PageInfoResult } from "../../src/cdp/types";
import { type Result, err, ok } from "../../src/util/result";

export const withClient = (client: BrowserClient, overrides: Partial<BrowserClient>): BrowserClient => ({
  ...client,
  ...overrides,
});

export const PAGE: PageInfo = {
  url: "https://example.test/page",
  title: "Example",
  width: 1000,
  height: 600,
  scrollX: 0,
  scrollY: 120,
  pageWidth: 1000,
  pageHeight: 4000,
};

export const pageInfoOf = (info: Partial<PageInfo> = {}): Result<PageInfoResult, CdpError> =>
  ok({ kind: "page", ...PAGE, ...info });

export const dialogOf = (dialog: DialogInfo): Result<PageInfoResult, CdpError> => ok({ kind: "dialog", dialog });

export const pageInfoError = (kind: CdpError["kind"], message: string, method?: string): Result<PageInfoResult, CdpError> =>
  err(cdpError(kind, message, method));

export const alwaysPageInfo = (r: Result<PageInfoResult, CdpError>): (() => Promise<Result<PageInfoResult, CdpError>>) =>
  () => Promise.resolve(r);

// Only the renderers' colour calls go through the theme, so any complete palette will do.
const FG_COLORS: Record<ThemeColor, number> = {
  accent: 7, border: 7, borderAccent: 7, borderMuted: 7, success: 7, error: 7, warning: 7, muted: 7, dim: 7, text: 7,
  thinkingText: 7, userMessageText: 7, customMessageText: 7, customMessageLabel: 7, toolTitle: 7, toolOutput: 7,
  mdHeading: 7, mdLink: 7, mdLinkUrl: 7, mdCode: 7, mdCodeBlock: 7, mdCodeBlockBorder: 7, mdQuote: 7, mdQuoteBorder: 7,
  mdHr: 7, mdListBullet: 7, toolDiffAdded: 7, toolDiffRemoved: 7, toolDiffContext: 7, syntaxComment: 7, syntaxKeyword: 7,
  syntaxFunction: 7, syntaxVariable: 7, syntaxString: 7, syntaxNumber: 7, syntaxType: 7, syntaxOperator: 7,
  syntaxPunctuation: 7, thinkingOff: 7, thinkingMinimal: 7, thinkingLow: 7, thinkingMedium: 7, thinkingHigh: 7,
  thinkingXhigh: 7, bashMode: 7,
};

export const testTheme = new Theme(
  FG_COLORS,
  { selectedBg: 0, userMessageBg: 0, customMessageBg: 0, toolPendingBg: 0, toolSuccessBg: 0, toolErrorBg: 0 },
  "256color",
);

// Markdown and keyHint read pi's global theme, which only pi's interactive mode initialises; the bundled dark theme is loaded
// for them, while renderers that take a Theme argument get the in-memory palette above.
export const installTheme = (): void => {
  initTheme("dark");
};

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
export const stripAnsi = (line: string): string => line.replace(ANSI_SEQUENCE, "").trimEnd();

export const renderedText = (component: Component, width = 80): string =>
  component.render(width).map(stripAnsi).join("\n");

// A minimal valid PNG (8-bit RGB, no filter) so sharp has real pixels to measure and resize.
export const pngOf = (width: number, height: number): Buffer => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
