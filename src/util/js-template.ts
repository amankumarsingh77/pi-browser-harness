// The ONLY supported way to interpolate untrusted values into evaluation source — never use raw template literals for JS crossing the CDP boundary.
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
