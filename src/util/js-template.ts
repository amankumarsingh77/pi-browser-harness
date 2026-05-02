/**
 * Build a JavaScript source string with safely-interpolated values.
 * Every interpolated value is JSON.stringify'd, so strings, numbers,
 * objects, and special characters all become valid JS literals.
 *
 * This is the ONLY supported way to interpolate untrusted values into
 * evaluation source — never use raw template literals for JS that
 * crosses the CDP boundary. The static parts of the template (the
 * `strings` array) must remain hard-coded; only the `${...}` slots
 * are sanitized.
 *
 * Values must be JSON-serializable: BigInt and Symbol throw at runtime;
 * functions and undefined serialize to `undefined`/omitted, which yields
 * a ReferenceError when evaluated. Pass strings, numbers, booleans,
 * plain objects, or arrays.
 */
export const safeJs = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): string => {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += JSON.stringify(values[i]);
    out += strings[i + 1] ?? "";
  }
  return out;
};
