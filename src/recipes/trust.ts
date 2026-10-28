import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { agentDir } from "../profile/paths";
import { isRecord } from "../util/guards";
import { type Result, err, ok } from "../util/result";
import { describeStep, fill, fillArgs, hostOf } from "./replay";
import type { Recipe } from "./recipe";
import { type StoredRecipe, recipeRoots } from "./store";

// A project recipe's absolute path -> sha256 of the file bytes the user approved, and `${path}#params` -> sha256 of the
// param-decided values (see paramScope) the user last approved for it.
type TrustStore = Readonly<Record<string, string>>;

const trustFile = (): string => join(agentDir(), "browser-harness", "trusted-recipes.json");

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const paramsKey = (path: string): string => `${resolve(path)}#params`;

const readStore = async (): Promise<TrustStore> => {
  try {
    const raw: unknown = JSON.parse(await readFile(trustFile(), "utf8"));
    if (!isRecord(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  } catch {
    return {};
  }
};

export const isTrusted = async (path: string, bytes: Uint8Array, scope?: string): Promise<boolean> => {
  const store = await readStore();
  return store[resolve(path)] === sha256(bytes) && (scope === undefined || store[paramsKey(path)] === sha256(scope));
};

export const trust = async (path: string, bytes: Uint8Array, scope?: string): Promise<void> => {
  const file = trustFile();
  const next: TrustStore = {
    ...(await readStore()),
    [resolve(path)]: sha256(bytes),
    ...(scope !== undefined ? { [paramsKey(path)]: sha256(scope) } : {}),
  };
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

// A URL template whose text before its first {{param}} already ends the origin cannot be sent elsewhere by a param.
const FIXED_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*[/?#]/i;
const steersOrigin = (template: string): boolean => {
  const at = template.indexOf("{{");
  return at !== -1 && !FIXED_ORIGIN.test(template.slice(0, at));
};

// An opaque origin ("null", as for file: URLs) names nothing, so the whole URL stands in for it.
const originOf = (url: string): string => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? url : origin;
  } catch {
    return url;
  }
};

// What this run's params decide outside the page: each origin a param can change and each local path a param fills.
// Undefined when params decide none of it, so such a recipe is approved once per file, whatever the values.
const paramScope = (recipe: Recipe, params: Readonly<Record<string, string>>): string | undefined => {
  const parts = recipe.steps.flatMap((s) => [
    ...[s.args["url"], s.expect?.url].flatMap((u) => (typeof u === "string" && steersOrigin(u) ? [originOf(fill(u, params))] : [])),
    ...[s.args["filePath"], s.args["downloadPath"]].flatMap((p) => (typeof p === "string" && p.includes("{{") ? [fill(p, params)] : [])),
  ]);
  return parts.length > 0 ? JSON.stringify(parts) : undefined;
};

const ESCAPES: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
// A param value is the caller's text: a raw newline or terminal escape in it could forge lines of the dialog.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const printable = (s: string): string => s.replace(CONTROL, (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const shownUrl = (url: string): string => {
  const origin = originOf(url);
  return origin === url ? url : `${url} (origin ${origin})`;
};

// What a project recipe can do outside the page: where it goes, which local files it sends, what it downloads. Shown
// with this run's params filled in, since a {{placeholder}} hides exactly what the user is approving.
const approvalBody = (stored: StoredRecipe, params: Readonly<Record<string, string>>, scoped: boolean): string => {
  const { recipe } = stored;
  const lines = recipe.steps.flatMap((s, i) => {
    const at = `  step ${i + 1}:`;
    const args = fillArgs(s.args, params);
    const url = args["url"];
    const file = args["filePath"];
    const lands = s.expect?.url !== undefined ? fill(s.expect.url, params) : undefined;
    if (s.action === "navigate" && typeof url === "string") return [`${at} navigate to ${shownUrl(url)}`];
    if (s.action === "new_tab" && typeof url === "string") return [`${at} open a new tab at ${shownUrl(url)}`];
    if (s.action === "upload_file" && typeof file === "string") return [`${at} upload ${file}`];
    if (s.action === "download") return [`${at} ${describeStep(s)}${typeof args["downloadPath"] === "string" ? ` to ${args["downloadPath"]}` : ""}`];
    if (lands !== undefined && hostOf(lands) !== recipe.site) return [`${at} ${describeStep(s)}, landing on ${shownUrl(lands)}`];
    return [];
  });
  const note = scoped ? ["", "Approval covers these values; a run with other values asks again."] : [];
  return [`File: ${stored.path}`, `Site: ${recipe.site}`, ...(lines.length > 0 ? ["", ...lines] : []), ...note, "", `${recipe.steps.length} steps`]
    .map(printable)
    .join("\n");
};

// A recipe from the project's .pi/browser-recipes was written by whoever wrote the repo and replays with no model in
// the loop, so its exact bytes, and the values its params give to URLs' origins and file paths, must be approved
// before it runs. Recipes under the agent dir are the user's own.
export const approveProjectRecipe = async (
  ctx: ExtensionContext,
  stored: StoredRecipe,
  params: Readonly<Record<string, string>>,
): Promise<Result<void, string>> => {
  if (!isProject(stored, ctx.cwd)) return ok(undefined);
  const name = stored.recipe.name;
  const bytes = await readFile(stored.path).catch(() => undefined);
  if (bytes === undefined) return err(`recipe ${name} could not be read at ${stored.path}`);
  const scope = paramScope(stored.recipe, params);
  if (await isTrusted(stored.path, bytes, scope)) return ok(undefined);
  if (!ctx.hasUI) return err(`recipe ${name} is a project recipe that has not been approved; run it once in an interactive session to approve it`);
  if (!(await ctx.ui.confirm(`Run project recipe ${name}?`, approvalBody(stored, params, scope !== undefined)))) return err(`recipe ${name} not run: not approved`);
  await trust(stored.path, bytes, scope);
  return ok(undefined);
};
