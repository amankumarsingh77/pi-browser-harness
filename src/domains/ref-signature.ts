import type { RefSignature } from "../cdp/types";
import type { SlimNode } from "./ax-tree";

export type { RefSignature };

export const signatureOf = (n: SlimNode): RefSignature => ({
  role: n.role,
  name: n.name ?? "",
  value: n.value ?? "",
  state: n.state ?? "",
});
