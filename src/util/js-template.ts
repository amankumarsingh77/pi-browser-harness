/**
 * Build a JavaScript source string with safely-interpolated values.
 * Every interpolated value is JSON.stringify'd, so strings, numbers,
 * objects, and special characters all become valid JS literals.
 *
 * This is the ONLY supported way to build evaluation source in the
 * codebase — never use raw template literals for JS that crosses the
 * CDP boundary.
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
