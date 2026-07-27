import { Type } from "typebox";
import { type Result, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";

const HandleDialogArgs = Type.Object({
  accept: Type.Boolean({ description: "true = accept, false = dismiss" }),
  promptText: Type.Optional(Type.String({ description: "Text to type if dialog is a prompt()" })),
});

export const handleDialogTool = defineBrowserTool({
  name: "browser_handle_dialog",
  label: "Browser Handle Dialog",
  description:
    "Accept or dismiss the currently open JS dialog (alert/confirm/prompt/beforeunload).",
  promptSnippet: "Accept or dismiss a JS dialog",
  promptGuidelines: [
    "Use after browser_page_info reports a dialog is open. Until handled, no other browser action will work.",
    "For prompt() dialogs, supply promptText with the value to submit.",
  ],
  parameters: HandleDialogArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await cdpCall(client, "Page.handleJavaScriptDialog", {
      accept: args.accept,
      ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
    });
    if (!r.success) return r;
    return ok({
      text: `Dialog ${args.accept ? "accepted" : "dismissed"}`,
      details: { accept: args.accept },
    });
  },
});
