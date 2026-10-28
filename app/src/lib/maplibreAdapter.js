import engine from "./mapRenderer.js";
import {Protocol as PmtilesProtocol} from "pmtiles";
import {reviewedArchiveTileResponse} from "./reviewedArchiveTiles.js";
import {registerMapFontProtocol} from "./mapFonts.js";
import {createGlRendererAdapter, rendererAdapterFor} from "./glRendererAdapter.js";

export const maplibreAdapter = createGlRendererAdapter({
  id: "maplibre",
  engine,
  requiresPainter: true,
  initialize: () => registerMapFontProtocol(engine)
});

// Created only when an active map needs archives; protocol registration belongs
// to each SDK, not a global flag shared by otherwise independent engines.
let archiveProtocol;
export function registerArchiveProtocols(adapter) {
  try {
    archiveProtocol ??= new PmtilesProtocol();
    adapter.registerProtocol("pmtiles", archiveProtocol.tile);
    adapter.registerProtocol("reviewed-archive", reviewedArchiveTileResponse);
    return true;
  } catch {
    return false;
  }
}

// Legacy helper callers can supply native MapLibre maps. Owned workbench maps
// always resolve to the adapter that constructed them.
export function workbenchRenderer(map) {
  return rendererAdapterFor(map, maplibreAdapter);
}
