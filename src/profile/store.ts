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
  // Background mode (/browser-background). Absent in files written before it existed, which reads as off.
  readonly background?: boolean;
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
    background: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const pinFileValidator = Compile(PinFileSchema);

type Settings = { readonly profile: ProfilePin | null; readonly background: boolean };

const NO_SETTINGS: Settings = { profile: null, background: false };

// A missing or unreadable file is the defaults, not an error: nothing has been chosen yet.
const readSettings = async (): Promise<Settings> => {
  let raw: string;
  try {
    raw = await readFile(pinFilePath(), "utf8");
  } catch {
    return NO_SETTINGS;
  }
  const parsed = parseJson(raw, pinFileValidator);
  if (!parsed.success) return NO_SETTINGS;
  const background = parsed.data.background === true;
  const profile = parsed.data.profile;
  if (profile === null) return { profile: null, background };
  const { userDataDir, profileDir, label, savedAt } = profile;
  return {
    background,
    profile: {
      userDataDir,
      profileDir,
      label: typeof label === "string" && label.length > 0 ? label : profileDir,
      savedAt: typeof savedAt === "string" ? savedAt : "",
    },
  };
};

export const readPin = async (): Promise<ProfilePin | null> => (await readSettings()).profile;

export const readBackgroundMode = async (): Promise<boolean> => (await readSettings()).background;

const writeSettings = async (settings: Settings, what: string): Promise<Result<void, string>> => {
  const target = pinFilePath();
  const tmp = `${target}.${randomUUID()}.tmp`;
  const payload: PinFile = {
    version: CURRENT_VERSION,
    profile: settings.profile,
    ...(settings.background ? { background: true } : {}),
  };
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
    return ok(undefined);
  } catch (e) {
    // The temp file may never have been created; the write error below is the one that matters.
    await unlink(tmp).catch(() => undefined);
    return err(`could not save ${what} to ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// Each setting is written with the other one read back first, so changing one never resets the other.
const writeProfile = async (profile: ProfilePin | null): Promise<Result<void, string>> =>
  writeSettings({ ...(await readSettings()), profile }, "profile selection");

export const writePin = (pin: ProfilePin): Promise<Result<void, string>> => writeProfile(pin);

export const clearPin = (): Promise<Result<void, string>> => writeProfile(null);

export const writeBackgroundMode = async (background: boolean): Promise<Result<void, string>> =>
  writeSettings({ ...(await readSettings()), background }, "the background mode setting");
