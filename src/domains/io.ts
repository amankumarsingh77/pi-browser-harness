import { readFile, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";

const ioErr = (what: string, path: string, e: unknown): ToolErr => ({
  kind: "io_error",
  message: `${what}: ${path} (${e instanceof Error ? e.message : String(e)})`,
  details: { path },
});

export const writeFileResult = async (path: string, data: Uint8Array | string): Promise<Result<void, ToolErr>> => {
  try {
    await writeFile(path, data);
    return ok(undefined);
  } catch (e) {
    return err(ioErr("Cannot write file", path, e));
  }
};

export const readFileResult = async (path: string): Promise<Result<Buffer, ToolErr>> => {
  try {
    return ok(await readFile(path));
  } catch (e) {
    return err(ioErr("Cannot read file", path, e));
  }
};

export const statResult = async (path: string): Promise<Result<Stats, ToolErr>> => {
  try {
    return ok(await stat(path));
  } catch (e) {
    return err(ioErr("Cannot stat file", path, e));
  }
};
