import type { SearchEngine } from "../serp";

// An immutable set of mounted engines. Mount order is the fallback ladder: the first engine mounted is tried first.
export type EngineRegistry = {
  // A new registry with `engine` appended to the ladder. Throws on a duplicate id: that is a wiring bug, caught at
  // composition time rather than surfacing as a confusing search.
  readonly mount: (engine: SearchEngine) => EngineRegistry;
  readonly get: (id: string) => SearchEngine | undefined;
  readonly ids: () => ReadonlyArray<string>;
  readonly ladder: () => ReadonlyArray<SearchEngine>;
};

const ENGINE_ID = /^[a-z][a-z0-9-]*$/;

const fromEngines = (engines: ReadonlyArray<SearchEngine>): EngineRegistry => {
  const byId = new Map(engines.map((e) => [e.id, e] as const));
  return {
    mount: (engine) => {
      if (!ENGINE_ID.test(engine.id)) throw new Error(`search engine id "${engine.id}" must match ${String(ENGINE_ID)}`);
      if (byId.has(engine.id)) throw new Error(`search engine "${engine.id}" is already mounted`);
      return fromEngines([...engines, engine]);
    },
    get: (id) => byId.get(id),
    ids: () => engines.map((e) => e.id),
    ladder: () => engines,
  };
};

export const createEngineRegistry = (): EngineRegistry => fromEngines([]);
