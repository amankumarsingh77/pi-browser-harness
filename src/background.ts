import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readBackgroundMode, writeBackgroundMode } from "./profile/store";
import { type Result } from "./util/result";
import { BACKGROUND_COMMAND, setNeverActivate } from "./util/activation";

export type BackgroundCommandDeps = {
  readonly readBackgroundMode?: () => Promise<boolean>;
  readonly writeBackgroundMode?: (on: boolean) => Promise<Result<void, string>>;
};

const ON_LABEL = "On: keep the browser in the background unless a tool needs it on screen";
const OFF_LABEL = "Off: the browser comes forward when the agent uses it (default)";

const ON_NOTICE =
  "Background mode: on ✓\nThe browser stays in the background while the agent reads, navigates and types. " +
  "It still comes forward when a tool needs the page on screen (a click, a drag, a scroll or a screenshot of a hidden tab), " +
  "and when the selected profile's window is first opened. Every tool works as it does with the mode off.\n" +
  "Saved. It stays on until you turn it off.";
const OFF_NOTICE = "Background mode: off ✓\nThe browser comes forward when the agent uses it. Saved.";

const describe = (on: boolean): string => (on ? "on" : "off");

const parseArg = (args: string): boolean | undefined => {
  const word = args.trim().toLowerCase();
  if (word === "on") return true;
  if (word === "off") return false;
  return undefined;
};

// /browser-background        pick from a list
// /browser-background on|off set it directly, which also works without a UI
export function registerBackgroundCommand(pi: ExtensionAPI, deps: BackgroundCommandDeps = {}): void {
  const read = deps.readBackgroundMode ?? readBackgroundMode;
  const write = deps.writeBackgroundMode ?? writeBackgroundMode;

  pi.registerCommand(BACKGROUND_COMMAND, {
    description: "Keep the browser in the background while the agent works (on/off)",
    handler: async (args, ctx) => {
      const current = await read();
      let wanted = parseArg(args);

      if (wanted === undefined && args.trim() !== "") {
        ctx.ui.notify(`Usage: /${BACKGROUND_COMMAND} [on|off]. Background mode is ${describe(current)}.`, "warning");
        return;
      }
      if (wanted === undefined) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`Background mode is ${describe(current)}. Run /${BACKGROUND_COMMAND} on or /${BACKGROUND_COMMAND} off to change it.`, "info");
          return;
        }
        const options = [`${current ? "✓" : " "} ${ON_LABEL}`, `${current ? " " : "✓"} ${OFF_LABEL}`];
        const answer = await ctx.ui.select("Background mode", options);
        if (answer === undefined) {
          ctx.ui.notify(`Background mode unchanged (${describe(current)}).`, "info");
          return;
        }
        wanted = answer === options[0];
      }

      const saved = await write(wanted);
      if (!saved.success) {
        ctx.ui.notify(saved.error, "error");
        return;
      }
      setNeverActivate(wanted);
      ctx.ui.notify(wanted ? ON_NOTICE : OFF_NOTICE, "info");
    },
  });
}
