import type { Static, TSchema } from "typebox";
import type { Validator } from "typebox/compile";
import { type Result, err, ok } from "../util/result";

export const parseJson = <S extends TSchema>(
  raw: string,
  validator: Validator<{}, S>,
): Result<Static<S>, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!validator.Check(parsed)) {
    const messages = validator
      .Errors(parsed)
      .map((x) => x.message)
      .join("; ");
    return err(messages.length > 0 ? messages : "JSON did not match the expected shape");
  }
  return ok(parsed);
};
