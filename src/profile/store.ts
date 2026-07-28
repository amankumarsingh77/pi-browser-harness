// A `browserContextId` is deliberately NOT persisted: Chrome mints fresh context ids per browser run, so a stored one could point into the wrong profile.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../schemas/parse";
import { type Result, err, ok } from "../util/result";
import { pinFilePath } from "./paths";

export type ProfilePin = {
  readonly userDataDir: string;
  readonly profileDir: string;
  readonly label: string;
  readonly savedAt: string;
};

type PinFile = {
  readonly version: 1;
  readonly profile: ProfilePin | null;
};

const CURRENT_VERSION = 1;

const PinFileSchema = Type.Object(
  {
    version: Type.Literal(CURRENT_VERSION),
    profile: Type.Union([
      Type.Object(
        {
          userDataDir: Type.String({ minLength: 1 }),
          profileDir: Type.String({ minLength: 1 }),
          label: Type.Optional(Type.Unknown()),
          savedAt: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: true },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: true },
);

const pinFileValidator = Compile(PinFileSchema);

export const readPin = async (): Promise<ProfilePin | null> => {
  let raw: string;
  try {
    raw = await readFile(pinFilePath(), "utf8");
  } catch {
    return null;
  }
  const parsed = parseJson(raw, pinFileValidator);
  if (!parsed.success) return null;
  const profile = parsed.data.profile;
  if (profile === null) return null;
  const { userDataDir, profileDir, label, savedAt } = profile;
  return {
    userDataDir,
    profileDir,
    label: typeof label === "string" && label.length > 0 ? label : profileDir,
    savedAt: typeof savedAt === "string" ? savedAt : "",
  };
};

const writePinFile = async (profile: ProfilePin | null): Promise<Result<void, string>> => {
  const target = pinFilePath();
  const tmp = `${target}.${randomUUID()}.tmp`;
  const payload: PinFile = { version: CURRENT_VERSION, profile };
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
    return ok(undefined);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    return err(`could not save profile selection to ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

export const writePin = (pin: ProfilePin): Promise<Result<void, string>> => writePinFile(pin);

export const clearPin = (): Promise<Result<void, string>> => writePinFile(null);
