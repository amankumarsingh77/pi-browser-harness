import { copyFile, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { agentDir } from "../profile/paths";
import { type Result, err, ok } from "../util/result";
import { type LastRun, RECIPE_SITE, type Recipe, parseRecipe, stringifyRecipe } from "./recipe";

export type StoredRecipe = { readonly recipe: Recipe; readonly path: string; readonly root: string };

export const recipeRoots = (cwd: string): { readonly project: string; readonly user: string } => ({
  project: join(cwd, ".pi", "browser-recipes"),
  user: join(agentDir(), "browser-recipes"),
});

const readStored = async (root: string, path: string): Promise<Result<StoredRecipe, string>> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return err(`no recipe file at ${path}`);
  }
  const parsed = parseRecipe(text);
  if (!parsed.success) return err(`${path}: ${parsed.error}`);
  return ok({ recipe: parsed.data, path, root });
};

const filesUnder = async (root: string): Promise<ReadonlyArray<string>> => {
  const sites = await readdir(root).catch(() => []);
  const out: string[] = [];
  for (const site of sites) {
    const names = await readdir(join(root, site)).catch(() => []);
    for (const n of names) if (n.endsWith(".yaml")) out.push(join(root, site, n));
  }
  return out;
};

// Project recipes shadow user recipes of the same name.
export const listRecipes = async (cwd: string): Promise<ReadonlyArray<StoredRecipe>> => {
  const { project, user } = recipeRoots(cwd);
  const seen = new Set<string>();
  const out: StoredRecipe[] = [];
  for (const root of [project, user]) {
    for (const path of await filesUnder(root)) {
      const stored = await readStored(root, path);
      if (!stored.success || seen.has(stored.data.recipe.name)) continue;
      seen.add(stored.data.recipe.name);
      out.push(stored.data);
    }
  }
  return out;
};

export const findRecipe = async (cwd: string, name: string): Promise<Result<StoredRecipe, string>> => {
  const { project, user } = recipeRoots(cwd);
  for (const root of [project, user]) {
    for (const path of await filesUnder(root)) {
      if (!path.endsWith(`/${name}.yaml`)) continue;
      return readStored(root, path);
    }
  }
  return err(`no recipe named "${name}"; call browser_run_recipe with no name to list saved recipes`);
};

const writeAtomic = async (path: string, text: string): Promise<void> => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
};

// A save over an existing recipe keeps the old file under .history and bumps the version (R5).
export const saveRecipe = async (root: string, recipe: Recipe): Promise<Result<StoredRecipe, string>> => {
  const dir = join(root, recipe.site);
  if (!RECIPE_SITE.test(recipe.site) || !resolve(dir).startsWith(resolve(root) + sep)) {
    return err(`refusing to save recipe ${recipe.name}: site "${recipe.site}" is not a host name`);
  }
  const path = join(dir, `${recipe.name}.yaml`);
  try {
    await mkdir(dir, { recursive: true });
    const existing = await readStored(root, path);
    let version = recipe.version;
    if (existing.success) {
      const history = join(dir, ".history");
      await mkdir(history, { recursive: true });
      await copyFile(path, join(history, `${recipe.name}.v${existing.data.recipe.version}.yaml`));
      version = existing.data.recipe.version + 1;
    }
    const saved: Recipe = { ...recipe, version };
    await writeAtomic(path, stringifyRecipe(saved));
    return ok({ recipe: saved, path, root });
  } catch (e) {
    return err(`could not save recipe to ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// Records the outcome of a replay without bumping the version; a run is not a new recipe.
export const recordRun = async (stored: StoredRecipe, lastRun: LastRun): Promise<void> => {
  await writeAtomic(stored.path, stringifyRecipe({ ...stored.recipe, lastRun })).catch(() => undefined);
};
