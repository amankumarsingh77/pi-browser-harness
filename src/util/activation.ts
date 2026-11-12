import { envFlagEnabled } from "./debug";

// The opt-in never-activate policy: the harness may not bring the browser, one of its windows or
// one of its tabs to the front. Off by default. Read on the pi side only, where every activating
// call is made; the daemon never activates anything.
let flagEnabled = false;

export const setNeverActivate = (on: boolean): void => {
  flagEnabled = on;
};

export const neverActivate = (env: NodeJS.ProcessEnv = process.env): boolean =>
  flagEnabled || envFlagEnabled(env["BH_NEVER_ACTIVATE"]);

export const POLICY_OFF_HINT = "turn the never-activate policy off (--browser-never-activate / BH_NEVER_ACTIVATE)";

// Spread into Target.createTarget params. Without `background`, Chrome focuses what it creates.
export const createInBackground = (): { readonly background?: true } => (neverActivate() ? { background: true } : {});
