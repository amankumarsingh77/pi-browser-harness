let flagEnabled = false;

export const setDebugClicks = (on: boolean): void => {
  flagEnabled = on;
};

export const debugClicksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  flagEnabled || Boolean(env["BH_DEBUG_CLICKS"]);
