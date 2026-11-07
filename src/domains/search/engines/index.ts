// Composition root for the built-in engines. The order of mounts is the default fallback ladder. To add an engine,
// write engines/<id>.ts exporting a SearchEngine and mount it here — or mount it onto defaultEngines() and inject the
// result into createWebSearchTool from outside.
import { bing } from "./bing";
import { brave } from "./brave";
import { duckduckgo } from "./duckduckgo";
import { google } from "./google";
import { createEngineRegistry, type EngineRegistry } from "./registry";

export const defaultEngines = (): EngineRegistry =>
  createEngineRegistry().mount(google).mount(bing).mount(duckduckgo).mount(brave);

export { createEngineRegistry, type EngineRegistry } from "./registry";
