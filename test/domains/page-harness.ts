// Runs a page function the way Chrome would: from its SOURCE TEXT, re-materialised at global scope where the module
// it came from is invisible. A page function that leans on module scope fails here with a ReferenceError, exactly as
// it would inside the page.
import { runInThisContext } from "node:vm";
import { type PageFunction, pageFunctionSource } from "../../src/domains/page/inject";

export const materialise = (fn: PageFunction): unknown => {
  const made: unknown = runInThisContext("(" + pageFunctionSource(fn) + ")");
  if (typeof made !== "function") throw new Error(`page function ${fn.name} did not re-materialise as a function`);
  return made;
};

// Calls the re-materialised function. Element functions take the element as their first argument.
export const callPage = (fn: PageFunction, ...args: ReadonlyArray<unknown>): unknown => {
  const made = materialise(fn);
  if (typeof made !== "function") throw new Error("unreachable: materialise returned a non-function");
  const out: unknown = Reflect.apply(made, undefined, [...args]);
  return out;
};
