import type { BrowserClient } from "../client";
import { refreshRefs } from "../domains/ref-resolve";
import { type Result, err, ok } from "../util/result";
import { sleep } from "../util/sleep";
import type { Locator } from "./journal";

export type TargetArgs = { readonly ref: string } | { readonly selector: string } | { readonly x: number; readonly y: number };

export const FIND_TIMEOUT_MS = 5_000;
const POLL_MS = 250;

// Chrome's accessible names differ in spacing from one load to the next ("Homepage (g then d)" against
// "Homepage ( g then d )"), so names are compared with runs of whitespace collapsed and none around brackets.
const normalName = (name: string): string =>
  name
    .replace(/\s+/g, " ")
    .replace(/\s*([()[\]{}])\s*/g, "$1")
    .trim();

export const sameName = (a: string, b: string): boolean => normalName(a) === normalName(b);

const nthMatch = (client: BrowserClient, role: string, name: string, nth: number): string | undefined => {
  let seen = 0;
  for (const [ref, sig] of client.session().refSignatures()) {
    if (sig.role !== role || !sameName(sig.name, name)) continue;
    if (seen === nth) return ref;
    seen += 1;
  }
  return undefined;
};

// A role+name locator is retried until the element shows up, which replaces the sleeps a recording would need.
// A css locator or a point passes through: the tools resolve those themselves.
export const findTarget = async (client: BrowserClient, locator: Locator, signal?: AbortSignal): Promise<Result<TargetArgs, string>> => {
  if ("css" in locator) return ok({ selector: locator.css });
  if ("x" in locator) return ok({ x: locator.x, y: locator.y });
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const refreshed = await refreshRefs(client);
    if (refreshed.success) {
      const ref = nthMatch(client, locator.role, locator.name, locator.nth);
      if (ref !== undefined) return ok({ ref });
    }
    if (Date.now() >= deadline || signal?.aborted) break;
    await sleep(POLL_MS, signal);
  }
  const which = locator.nth > 0 ? ` (match ${locator.nth + 1})` : "";
  return err(`no ${locator.role} named "${locator.name}"${which} on the page after ${FIND_TIMEOUT_MS / 1000}s`);
};
