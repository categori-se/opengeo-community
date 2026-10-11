import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  layerMoveState,
  normalizeProjectLayerOrder,
  orderedProjectLayerTree,
  reorderedLayerStack,
  restoreSavedLayerOrder,
  ungroupedLayerIds
} from "../src/lib/layerOrder.js";

const TREE = [{
  kind: "group",
  id: "screening",
  title: "Screening",
  children: ["population", "pollution", "score"].map((layerId) => ({kind: "layer", layerId}))
}, {
  kind: "group",
  id: "reference",
  title: "Reference",
  children: [{kind: "layer", layerId: "roads"}]
}];

const layers = (...ids) => ids.map((layerId, order) => ({layerId, order}));

describe("project layer ordering", () => {
  it("keeps ungrouped runtime layers in a top segment and configured groups intact", () => {
    const ordered = normalizeProjectLayerOrder(
      layers("population", "drawn-point", "roads", "pollution", "imported", "score"),
      TREE
    );
    assert.deepEqual(ordered.map(({layerId}) => layerId), [
      "drawn-point", "imported", "population", "pollution", "score", "roads"
    ]);
    assert.deepEqual(ungroupedLayerIds(TREE, ordered), ["drawn-point", "imported"]);
  });

  it("derives configured sibling order from the live layer stack without removing groups", () => {
    const ordered = orderedProjectLayerTree(TREE, layers("pollution", "population", "score", "roads"));
    assert.deepEqual(ordered.map(({id}) => id), ["screening", "reference"]);
    assert.deepEqual(ordered[0].children.map(({layerId}) => layerId), ["pollution", "population", "score"]);
  });

  it("moves only within the current configured or ungrouped sibling segment", () => {
    const current = layers("drawn-point", "imported", "population", "pollution", "score", "roads");
    assert.deepEqual(layerMoveState(current, TREE, "population"), {
      segmentIds: ["population", "pollution", "score"],
      index: 0,
      canMoveUp: false,
      canMoveDown: true
    });
    assert.deepEqual(
      reorderedLayerStack(current, TREE, "pollution", -1).map(({layerId}) => layerId),
      ["drawn-point", "imported", "pollution", "population", "score", "roads"]
    );
    assert.deepEqual(
      reorderedLayerStack(current, TREE, "population", -1).map(({layerId}) => layerId),
      current.map(({layerId}) => layerId),
      "a configured layer crossed its group boundary"
    );
    assert.deepEqual(
      reorderedLayerStack(current, TREE, "imported", 1).map(({layerId}) => layerId),
      current.map(({layerId}) => layerId),
      "an ungrouped layer crossed into a configured group"
    );
  });

  it("restores saved relative order while leaving new authoritative layers in their slots", () => {
    const current = layers("population", "new-server-layer", "pollution", "score");
    const restored = restoreSavedLayerOrder(current, layers("score", "population", "pollution"));
    assert.deepEqual(restored.map(({layerId}) => layerId), [
      "score", "new-server-layer", "population", "pollution"
    ]);
  });
});

it('raises only explicitly opted-in label passes, preserving existing occurrence order',async()=>{
 const {orderedRenderLayerIds}=await import('../src/lib/layerOrder.js');
 const layers=[{layerId:'top'},{layerId:'bottom'}];
 const handles=new Map(layers.map(l=>[l.layerId,{layerIds:[l.layerId,l.layerId+'-label'],labelLayerId:l.layerId+'-label'}]));
 assert.deepEqual(orderedRenderLayerIds(layers,handles),['bottom','bottom-label','top','top-label']);
 layers[1].labels={drawOrder:'above-data'};
 assert.deepEqual(orderedRenderLayerIds(layers,handles),['bottom','top','top-label','bottom-label']);
 layers[0].labels={drawOrder:'above-data'};
 assert.deepEqual(orderedRenderLayerIds(layers,handles),['bottom','top','bottom-label','top-label']);
});
