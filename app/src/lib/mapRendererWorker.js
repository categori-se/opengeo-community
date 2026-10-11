import {FileAttachment} from "observablehq:stdlib";

// Framework retains and hashes this generated asset. A relative upstream worker
// URL would otherwise point beside Framework's rewritten npm module.
export async function configureMapWorker(engine) {
  engine.setWorkerUrl(await FileAttachment("../assets/maplibre-worker.js").url());
}
