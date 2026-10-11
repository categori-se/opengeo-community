import * as renderer from "maplibre-gl/dist/maplibre-gl.mjs";

// Explicit ESM entry avoids Framework's CommonJS resolution of bare packages.
// Keep all browser map surfaces on the same configured namespace.
const engine = renderer.default ?? renderer;
if (typeof window !== "undefined" && engine.getVersion().startsWith("6.")) {
  const {configureMapWorker} = await import("./mapRendererWorker.js");
  await configureMapWorker(engine);
}
export default engine;
