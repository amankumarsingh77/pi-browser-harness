import { Type } from "typebox";
import type { ParamsOf } from "../cdp/commands";
import { type Result, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";

const DragArgs = Type.Object({
  startX: Type.Number(),
  startY: Type.Number(),
  endX: Type.Number(),
  endY: Type.Number(),
  dataTransfer: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Optional MIME → data map for DataTransfer (e.g., { 'text/plain': 'hello' })",
    }),
  ),
});

export const dragAndDropTool = defineBrowserTool({
  name: "browser_drag_and_drop",
  label: "Browser Drag & Drop",
  description: "Drag from (startX, startY) to (endX, endY) using CDP Input.dispatchDragEvent.",
  promptSnippet: "Drag and drop between two coordinates",
  promptGuidelines: [
    "Coordinates in CSS pixels.",
    "dataTransfer is an optional MIME→data map (e.g., { 'text/plain': 'hello' }).",
  ],
  parameters: DragArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const data: ParamsOf<"Input.dispatchDragEvent">["data"] = {
      items: Object.entries(args.dataTransfer ?? {}).map(([mimeType, payload]) => ({
        mimeType,
        data: Buffer.from(payload).toString("base64"),
      })),
      dragOperationsMask: 1,
    };
    // Each step is a thunk so the whole sequence is typed against the real Input schemas and still runs in order.
    const mouse = (p: ParamsOf<"Input.dispatchMouseEvent">) => () => cdpCall(client, "Input.dispatchMouseEvent", p);
    const drag = (p: ParamsOf<"Input.dispatchDragEvent">) => () => cdpCall(client, "Input.dispatchDragEvent", p);
    const steps = [
      mouse({ type: "mousePressed", x: args.startX, y: args.startY, button: "left", clickCount: 1 }),
      drag({ type: "dragEnter", x: args.startX, y: args.startY, data, modifiers: 0 }),
      ...Array.from({ length: 5 }, (_, i) => {
        const t = (i + 1) / 5;
        return drag({
          type: "dragOver",
          x: Math.round(args.startX + (args.endX - args.startX) * t),
          y: Math.round(args.startY + (args.endY - args.startY) * t),
          data,
          modifiers: 0,
        });
      }),
      drag({ type: "drop", x: args.endX, y: args.endY, data, modifiers: 0 }),
      mouse({ type: "mouseReleased", x: args.endX, y: args.endY, button: "left", clickCount: 1 }),
    ];
    for (const step of steps) {
      const r = await step();
      if (!r.success) return r;
    }
    return ok({
      text: `Dragged from (${args.startX},${args.startY}) to (${args.endX},${args.endY})`,
    });
  },
});
