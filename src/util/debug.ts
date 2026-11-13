let flagEnabled = false;

export const setDebugClicks = (on: boolean): void => {
  flagEnabled = on;
};

const TRUTHY: ReadonlySet<string> = new Set(["1", "true"]);

// Only an explicit "1" or "true" counts: "0" and "false" are set to turn the overlay off, not on.
const envFlagEnabled = (value: string | undefined): boolean =>
  value !== undefined && TRUTHY.has(value.trim().toLowerCase());

export const debugClicksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  flagEnabled || envFlagEnabled(env["BH_DEBUG_CLICKS"]);
