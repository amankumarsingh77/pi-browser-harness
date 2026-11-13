// Background mode: the harness may not bring the browser, one of its windows or one of its tabs to
// the front. Off by default; the user turns it on with /browser-background and the choice is saved
// (src/profile/store.ts). Held on the pi side only, where every activating call is made; the daemon
// never activates anything.
let enabled = false;

export const setNeverActivate = (on: boolean): void => {
  enabled = on;
};

export const neverActivate = (): boolean => enabled;

export const BACKGROUND_COMMAND = "browser-background";

// Spread into Target.createTarget params. Without `background`, Chrome focuses what it creates.
export const createInBackground = (): { readonly background?: true } => (neverActivate() ? { background: true } : {});
