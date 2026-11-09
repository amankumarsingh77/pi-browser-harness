// CDP cannot open a window in another profile, so this goes through the command line: ProcessSingleton hands the argv to the running browser.
// The sentinel must ride on a real `file://` URL — Chrome discards a bare `about:blank#token` argument and opens chrome://newtab instead.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Result, err, ok } from "../util/result";

export type ProfileWindowRequest = {
  readonly exePath: string;
  readonly profileDir: string;
  readonly explicitUserDataDir?: string;
};

export type ProfileWindowHandle = {
  readonly sentinelUrl: string;
  readonly cleanup: () => Promise<void>;
  readonly kill: () => void;
};

const SENTINEL_HTML = (token: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${token}</title>` +
  `<body style="font:14px system-ui;padding:2rem;color:#555">pi browser harness — opening this profile…</body>`;

// Starts the browser detached from pi, so it outlives the session that opened it.
const spawnDetached = async (exePath: string, args: ReadonlyArray<string>): Promise<Result<ChildProcess, string>> => {
  let child: ChildProcess;
  try {
    child = spawn(exePath, [...args], { detached: true, stdio: "ignore" });
  } catch (e) {
    return err(`could not launch ${exePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // spawn() reports a bad binary asynchronously as an 'error' event rather than throwing; unhandled, an ENOENT looked like the 15s sentinel timeout.
  const spawnFailure = await new Promise<string | undefined>((resolve) => {
    child.once("spawn", () => { resolve(undefined); });
    child.once("error", (e: Error) => { resolve(e.message); });
  });
  // A later 'error' event with no listener would throw, so keep one attached for the detached launcher's lifetime.
  child.on("error", () => undefined);
  child.unref();

  return spawnFailure ? err(`could not launch ${exePath}: ${spawnFailure}`) : ok(child);
};

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

  const discardSentinel = (): Promise<void> => rm(file, { force: true }).catch(() => undefined);

  const spawned = await spawnDetached(req.exePath, args);
  if (!spawned.success) {
    await discardSentinel();
    return spawned;
  }

  let live: ChildProcess | null = spawned.data;

  return ok({
    sentinelUrl,
    cleanup: discardSentinel,
    kill: () => {
      if (live) {
        try {
          live.kill("SIGTERM");
        } catch {
          // The process already exited; there is nothing left to kill.
        }
        live = null;
      }
    },
  });
};

export type BrowserLaunchRequest = {
  readonly exePath: string;
  readonly profileDir?: string;
};

export const browserLaunchArgs = (req: BrowserLaunchRequest): ReadonlyArray<string> =>
  req.profileDir === undefined ? [] : [`--profile-directory=${req.profileDir}`];

// Opens a browser that is not running. No --user-data-dir and no debugging flag: it starts as the user's own browser, with whatever remote-debugging setting they left it in.
export const launchBrowser = async (req: BrowserLaunchRequest): Promise<Result<void, string>> => {
  const spawned = await spawnDetached(req.exePath, browserLaunchArgs(req));
  return spawned.success ? ok(undefined) : spawned;
};
