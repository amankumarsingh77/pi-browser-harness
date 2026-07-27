/**
 * Durable persistence for the selected browser profile.
 *
 * The pin must outlive session termination, so it cannot live in pi's session
 * entries (`pi.appendEntry`, see src/state.ts) — those die with the session.
 * It is a small JSON file in pi's agent config dir instead, shared by every
 * project on the machine.
 *
 * The pin deliberately stores only `{ userDataDir, profileDir }`. A
 * `browserContextId` is NOT persisted: Chrome mints fresh context ids on every
 * browser run, so a stored one would be a stale pointer at best and a pointer
 * into the wrong profile at worst. The context is re-resolved on each connect.
 *
 * Every read failure degrades to "no pin" rather than throwing — a corrupt
 * file must never break browser control.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../schemas/parse";
import { type Result, err, ok } from "../util/result";
import { pinFilePath } from "./paths";

export type ProfilePin = {
  /** User-data-dir the profile belongs to — guards against browser switches. */
  readonly userDataDir: string;
  /** Profile subdirectory, e.g. "Profile 1". */
  readonly profileDir: string;
  /** Label captured at selection time, for display without a disk re-read. */
  readonly label: string;
  /** ISO timestamp of the selection. */
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

/**
 * The persisted pin, or null when nothing is pinned, the file is missing, or
 * it cannot be parsed. A file written by a newer version is treated as "no
 * pin" rather than guessed at.
 */
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

/**
 * Replace the pin atomically: a sibling temp file plus rename, so a crash
 * mid-write can never leave a half-written pin behind.
 */
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

/** Persist the selected profile. */
export const writePin = (pin: ProfilePin): Promise<Result<void, string>> => writePinFile(pin);

/** Clear the selection, restoring the harness's unpinned behavior. */
export const clearPin = (): Promise<Result<void, string>> => writePinFile(null);
