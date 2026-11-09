import { type CdpEndpoint, endpointFromEnv, isLoopbackWsUrl, probeEndpoint } from "./cdp/discovery";
import { isBrowserRunning } from "./profile/browser-process";

// Where the browser is, decided once. A reachable DevTools endpoint is what makes a browser usable;
// a browser process on this machine only tells us whether its profiles and executable are here too.
export type BrowserLocation =
  // A browser on this machine. No endpoint means it is running with remote debugging off.
  | { readonly kind: "local"; readonly endpoint?: CdpEndpoint }
  // Reachable, but not a process here (SSH tunnel, the Windows host from WSL, a container): its profiles and executable are out of reach.
  | { readonly kind: "remote"; readonly endpoint: CdpEndpoint }
  | { readonly kind: "none" };

export type LocateDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly probeEndpoint?: () => Promise<CdpEndpoint | undefined>;
  readonly isBrowserRunning?: () => Promise<boolean>;
};

export const locateBrowser = async (deps: LocateDeps = {}): Promise<BrowserLocation> => {
  const running = deps.isBrowserRunning ?? isBrowserRunning;

  // BU_CDP_WS names the endpoint outright, so nothing is probed. Another host is remote whatever runs here; on loopback it is commonly this machine's own browser, hence the process check.
  const override = endpointFromEnv(deps.env ?? process.env);
  if (override) {
    const local = isLoopbackWsUrl(override.wsUrl) && (await running());
    return local ? { kind: "local", endpoint: override } : { kind: "remote", endpoint: override };
  }

  const [endpoint, isRunning] = await Promise.all([(deps.probeEndpoint ?? probeEndpoint)(), running()]);
  if (!endpoint) return isRunning ? { kind: "local" } : { kind: "none" };
  // A user-data-dir means the endpoint came from a port file on this machine's disk.
  if (endpoint.userDataDir !== undefined || isRunning) return { kind: "local", endpoint };
  return { kind: "remote", endpoint };
};
