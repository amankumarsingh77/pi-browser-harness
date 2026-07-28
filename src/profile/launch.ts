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

  let child: ChildProcess;
  try {
    child = spawn(req.exePath, args, { detached: true, stdio: "ignore" });
  } catch (e) {
    await rm(file, { force: true }).catch(() => {});
    return err(`could not launch ${req.exePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // spawn() reports a bad binary asynchronously as an 'error' event rather than throwing; unhandled, an ENOENT looked like the 15s sentinel timeout.
  const spawnFailure = await new Promise<string | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", (e: Error) => resolve(e.message));
  });
  // A later 'error' event with no listener would throw, so keep one attached for the detached launcher's lifetime.
  child.on("error", () => {});
  child.unref();

  if (spawnFailure) {
    await rm(file, { force: true }).catch(() => {});
    return err(`could not launch ${req.exePath}: ${spawnFailure}`);
  }

  let live: ChildProcess | null = child;

  return ok({
    sentinelUrl,
    cleanup: async () => {
      await rm(file, { force: true }).catch(() => {});
    },
    kill: () => {
      if (live) {
        try { live.kill("SIGTERM"); } catch {}
        live = null;
      }
    },
  });
};
