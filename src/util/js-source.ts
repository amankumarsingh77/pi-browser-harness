import { parse } from "acorn";
import { isRecord } from "./guards";

const FUNCTION_NODES: ReadonlySet<string> = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

// True when a return statement sits in the program body itself, not inside a function it defines.
const hasTopLevelReturn = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(hasTopLevelReturn);
  if (!isRecord(node) || typeof node["type"] !== "string") return false;
  if (node["type"] === "ReturnStatement") return true;
  if (FUNCTION_NODES.has(node["type"])) return false;
  return Object.values(node).some((v) => typeof v === "object" && v !== null && hasTopLevelReturn(v));
};

// The source Runtime.evaluate should run for what the model wrote. A top-level `return`, anywhere in the body,
// makes it a function body, so it runs inside an async function whose result is awaited. Anything else, including
// source that does not parse, is sent as written, so the page reports its own error.
export const pageExpression = (src: string): string => {
  let program: unknown;
  try {
    program = parse(src, { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  } catch {
    return src;
  }
  return isRecord(program) && hasTopLevelReturn(program["body"]) ? `(async () => {\n${src}\n})()` : src;
};
