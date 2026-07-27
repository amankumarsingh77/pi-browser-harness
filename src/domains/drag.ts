import { Type } from "typebox";
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
    const data = args.dataTransfer
      ? {
          items: Object.entries(args.dataTransfer).map(([mimeType, payload]) => ({
            mimeType,
            data: Buffer.from(payload).toString("base64"),
          })),
          dragOperationsMask: 1,
        }
      : { items: [], dragOperationsMask: 1 };
    type InputCall = readonly ["Input.dispatchMouseEvent" | "Input.dispatchDragEvent", Record<string, unknown>];
    const calls: ReadonlyArray<InputCall> = [
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: args.startX, y: args.startY, button: "left", clickCount: 1 }],
      ["Input.dispatchDragEvent", { type: "dragEnter", x: args.startX, y: args.startY, data, modifiers: 0 }],
      // 5 interpolated dragOver steps from start → end so the page sees a smooth drag.
      ...Array.from({ length: 5 }, (_, i): InputCall => {
        const t = (i + 1) / 5;
        return [
          "Input.dispatchDragEvent",
          {
            type: "dragOver",
            x: Math.round(args.startX + (args.endX - args.startX) * t),
            y: Math.round(args.startY + (args.endY - args.startY) * t),
            data,
            modifiers: 0,
          },
        ];
      }),
      ["Input.dispatchDragEvent", { type: "drop", x: args.endX, y: args.endY, data, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: args.endX, y: args.endY, button: "left", clickCount: 1 }],
    ];
    for (const [method, params] of calls) {
      const r = await cdpCall(client, method, params);
      if (!r.success) return r;
    }
    return ok({
      text: `Dragged from (${args.startX},${args.startY}) to (${args.endX},${args.endY})`,
    });
  },
});
