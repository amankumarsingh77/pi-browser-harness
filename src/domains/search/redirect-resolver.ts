// Resolves one Google /goto?url=<opaque blob> link to its target by reading the server's redirect, without
// following it. The blob cannot be decoded client-side and the page's <cite> is only a display breadcrumb, so this
// is the one source of the exact url. Google answers the redirect to a cookie-less GET; HEAD returns 200 instead.

import { isGotoRedirect } from "./google-serp";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

export type RedirectResolver = (href: string, signal: AbortSignal) => Promise<string | undefined>;

export type ResolveOptions = {
  // Defence in depth: the parser already filters to /goto hrefs, and the resolver refuses anything else again so a
  // caller bug cannot turn it into a generic url fetcher. Tests against a local server opt out explicitly.
  readonly requireGoto?: boolean;
};

export const fetchRedirectTarget = async (
  href: string,
  signal: AbortSignal,
  opts: ResolveOptions = {},
): Promise<string | undefined> => {
  if ((opts.requireGoto ?? true) && !isGotoRedirect(href)) return undefined;
  try {
    const response = await fetch(href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    });
    // The body is never read; cancelling it releases the socket without waiting for Google to finish sending.
    await response.body?.cancel().catch(() => undefined);
    if (!REDIRECT_STATUSES.has(response.status)) return undefined;
    const location = response.headers.get("location");
    if (location === null || location === "") return undefined;
    return new URL(location, href).toString();
  } catch {
    return undefined;
  }
};
