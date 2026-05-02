import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

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
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const params: Record<string, unknown> = { accept: args.accept };
    if (args.promptText !== undefined) params["promptText"] = args.promptText;
    const r = await client.session().call("Page.handleJavaScriptDialog", params);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({
      text: `Dialog ${args.accept ? "accepted" : "dismissed"}`,
      details: { accept: args.accept },
    });
  },
});
