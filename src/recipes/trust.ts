import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { agentDir } from "../profile/paths";
import { isRecord } from "../util/guards";
import { type Result, err, ok } from "../util/result";
import { describeStep } from "./replay";
import { type StoredRecipe, recipeRoots } from "./store";

// A project recipe's absolute path -> sha256 of the file bytes the user approved.
type TrustStore = Readonly<Record<string, string>>;

const trustFile = (): string => join(agentDir(), "browser-harness", "trusted-recipes.json");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const readStore = async (): Promise<TrustStore> => {
  try {
    const raw: unknown = JSON.parse(await readFile(trustFile(), "utf8"));
    if (!isRecord(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  } catch {
    return {};
  }
};

export const isTrusted = async (path: string, bytes: Uint8Array): Promise<boolean> =>
  (await readStore())[resolve(path)] === sha256(bytes);

export const trust = async (path: string, bytes: Uint8Array): Promise<void> => {
  const file = trustFile();
  const next: TrustStore = { ...(await readStore()), [resolve(path)]: sha256(bytes) };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
};

const isProject = (stored: StoredRecipe, cwd: string): boolean => stored.root === recipeRoots(cwd).project;

// The harness's own writes to a project recipe (a save, a repair, last_run) never make the user approve it again.
export const trustWritten = async (stored: StoredRecipe, cwd: string): Promise<void> => {
  if (!isProject(stored, cwd)) return;
  const bytes = await readFile(stored.path).catch(() => undefined);
  if (bytes !== undefined) await trust(stored.path, bytes).catch(() => undefined);
};

// What a project recipe can do outside the page: where it goes, which local files it sends, what it downloads.
const approvalBody = (stored: StoredRecipe): string => {
  const { recipe } = stored;
  const lines = recipe.steps.flatMap((s, i) => {
    const url = s.args["url"];
    const file = s.args["filePath"];
    if (s.action === "navigate" && typeof url === "string") return [`  step ${i + 1}: navigate to ${url}`];
    if (s.action === "upload_file" && typeof file === "string") return [`  step ${i + 1}: upload ${file}`];
    if (s.action === "download") return [`  step ${i + 1}: ${describeStep(s)}${typeof s.args["downloadPath"] === "string" ? ` to ${s.args["downloadPath"]}` : ""}`];
    return [];
  });
  return [`File: ${stored.path}`, `Site: ${recipe.site}`, ...(lines.length > 0 ? ["", ...lines] : []), "", `${recipe.steps.length} steps`].join("\n");
};

// A recipe from the project's .pi/browser-recipes was written by whoever wrote the repo and replays with no model in
// the loop, so its exact bytes must be approved once before it runs. Recipes under the agent dir are the user's own.
export const approveProjectRecipe = async (ctx: ExtensionContext, stored: StoredRecipe): Promise<Result<void, string>> => {
  if (!isProject(stored, ctx.cwd)) return ok(undefined);
  const name = stored.recipe.name;
  const bytes = await readFile(stored.path).catch(() => undefined);
  if (bytes === undefined) return err(`recipe ${name} could not be read at ${stored.path}`);
  if (await isTrusted(stored.path, bytes)) return ok(undefined);
  if (!ctx.hasUI) return err(`recipe ${name} is a project recipe that has not been approved; run it once in an interactive session to approve it`);
  if (!(await ctx.ui.confirm(`Run project recipe ${name}?`, approvalBody(stored)))) return err(`recipe ${name} not run: not approved`);
  await trust(stored.path, bytes);
  return ok(undefined);
};
