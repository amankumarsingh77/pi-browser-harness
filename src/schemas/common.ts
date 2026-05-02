import { Type } from "typebox";

export const Coords = Type.Object({
  x: Type.Number({ description: "X coordinate in CSS pixels from left edge of viewport" }),
  y: Type.Number({ description: "Y coordinate in CSS pixels from top edge of viewport" }),
});

export const MouseButton = Type.Union(
  [Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")],
  { description: 'Mouse button: "left", "right", or "middle"' },
);
