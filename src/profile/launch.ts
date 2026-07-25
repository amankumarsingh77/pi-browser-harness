/**
 * Opening a browser window for a chosen profile.
 *
 * CDP cannot do this: `Target.createTarget` rejects another profile's
 * browserContextId ("Failed to find browser context with id"), and a bare
 * createTarget lands in `defaultBrowserContextId`, which follows window focus.
 * The only way in is the browser's own command line — Chromium's
 * ProcessSingleton hands a second launch's argv to the running browser, which
 * "does what it would have done", i.e. opens a window in `--profile-directory`.
 *
 * The window is then identified by a unique `file://` sentinel page. That
 * matters: a bare `about:blank#token` argument is discarded by Chrome (it opens
 * chrome://newtab instead), so the token has to ride on a real URL. Polling for
 * the sentinel URL — rather than diffing the target list — also keeps
 * identification correct when the user opens tabs at the same moment.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Result, err, ok } from "../util/result";

export type ProfileWindowRequest = {
  /** Browser binary to invoke. */
  readonly exePath: string;
  /** Profile subdirectory, e.g. "Profile 1". */
  readonly profileDir: string;
  /**
   * Only set when the RUNNING browser was launched with an explicit
   * --user-data-dir. ProcessSingleton keys on this path, so passing one that
   * differs by case or normalisation would start a second browser instead of
   * delegating to the running one.
   */
  readonly explicitUserDataDir?: string;
};

export type ProfileWindowHandle = {
  /** file:// URL that will appear as the new window's page target. */
  readonly sentinelUrl: string;
  /** Remove the sentinel file. Safe to call more than once. */
  readonly cleanup: () => Promise<void>;
  readonly kill: () => void;
};

const SENTINEL_HTML = (token: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${token}</title>` +
  `<body style="font:14px system-ui;padding:2rem;color:#555">pi browser harness — opening this profile…</body>`;

/**
 * Ask the running browser to open a window in `profileDir`, marked with a
 * unique sentinel page the caller can then find over CDP.
 */
export const openProfileWindow = async (
  req: ProfileWindowRequest,
): Promise<Result<ProfileWindowHandle, string>> => {
  const token = `pi-harness-${randomUUID()}`;
  const file = join(tmpdir(), `${token}.html`);
  try {
    await writeFile(file, SENTINEL_HTML(token), "utf8");
  } catch (e) {
    return err(`could not write the profile handshake page: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sentinelUrl = pathToFileURL(file).href;
  const args: string[] = [];
  if (req.explicitUserDataDir) args.push(`--user-data-dir=${req.explicitUserDataDir}`);
  args.push(`--profile-directory=${req.profileDir}`, "--new-window", sentinelUrl);

  let child: ChildProcess | null = null;
  try {
    // No shell: arguments are passed as an array, so profile names and paths
    // containing spaces survive intact on every platform.
    child = spawn(req.exePath, args, { detached: true, stdio: "ignore" });
    child.unref();
    // The launcher process exits as soon as the running browser takes over the
    // command line; an error here means the binary itself could not be started.
    child.on("error", () => {});
  } catch (e) {
    await rm(file, { force: true }).catch(() => {});
    return err(`could not launch ${req.exePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok({
    sentinelUrl,
    cleanup: async () => {
      await rm(file, { force: true }).catch(() => {});
    },
    kill: () => {
      if (child) {
        try { child.kill("SIGTERM"); } catch {}
        child = null;
      }
    },
  });
};
