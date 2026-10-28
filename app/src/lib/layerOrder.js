const MAX_TREE_DEPTH = 8;
const MAX_TREE_NODES = 256;

export function configuredLayerIds(layerTree) {
  const ids = [];
  const seen = new Set();
  visitLayerTree(layerTree, (node) => {
    if (node.kind !== "layer" || typeof node.layerId !== "string" || seen.has(node.layerId)) return;
    seen.add(node.layerId);
    ids.push(node.layerId);
  });
  return ids;
}

export function ungroupedLayerIds(layerTree, layers) {
  const configured = new Set(configuredLayerIds(layerTree));
  return safeLayerIds(layers).filter((layerId) => !configured.has(layerId));
}

export function orderedProjectLayerTree(layerTree, layers) {
  const rank = new Map(safeLayerIds(layers).map((layerId, index) => [layerId, index]));
  let visited = 0;

  const orderNodes = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > MAX_TREE_DEPTH || visited >= MAX_TREE_NODES) return [];
    const output = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || visited >= MAX_TREE_NODES) continue;
      visited += 1;
      if (node.kind === "layer") {
        output.push({...node});
      } else if (node.kind === "group" && Array.isArray(node.children)) {
        output.push({...node, children: orderNodes(node.children, depth + 1)});
      }
    }

    const orderedLayers = output
      .filter((node) => node.kind === "layer" && rank.has(node.layerId))
      .sort((left, right) => rank.get(left.layerId) - rank.get(right.layerId));
    let layerIndex = 0;
    return output.map((node) => (
      node.kind === "layer" && rank.has(node.layerId)
        ? orderedLayers[layerIndex++]
        : node
    ));
  };

  return orderNodes(layerTree, 0);
}

export function normalizeProjectLayerOrder(layers, layerTree) {
  const safeLayers = uniqueLayers(layers);
  const byId = new Map(safeLayers.map((layer) => [layer.layerId, layer]));
  const configured = new Set(configuredLayerIds(layerTree));
  const ungrouped = safeLayers.filter(({layerId}) => !configured.has(layerId));
  const grouped = [];
  const seen = new Set(ungrouped.map(({layerId}) => layerId));

  visitLayerTree(orderedProjectLayerTree(layerTree, safeLayers), (node) => {
    if (node.kind !== "layer" || seen.has(node.layerId) || !byId.has(node.layerId)) return;
    seen.add(node.layerId);
    grouped.push(byId.get(node.layerId));
  });
  for (const layer of safeLayers) {
    if (!seen.has(layer.layerId)) grouped.push(layer);
  }
  return [...ungrouped, ...grouped];
}

// Sort only the chosen sibling list. Unfiled runtime Layers keep their existing
// top segment; sorting the root also sorts that segment without filing anything.
export function sortProjectLayerSiblings(layerTree, layers, parentId = "", direction = "ascending") {
  if (!["ascending", "descending"].includes(direction)) throw Error("Choose a supported sort order.");
  const tree = orderedProjectLayerTree(layerTree, layers);
  const byId = new Map(uniqueLayers(layers).map(layer => [layer.layerId, layer]));
  let target = parentId ? null : tree;
  visitLayerTree(tree, node => {
    if (node.kind === "group" && node.id === parentId) target = node.children;
  });
  if (!target) throw Error("Choose an existing destination folder.");
  const compare = (left, right) => {
    const a = String(left ?? "").normalize("NFKC").toLowerCase();
    const b = String(right ?? "").normalize("NFKC").toLowerCase();
    return (a < b ? -1 : a > b ? 1 : 0) * (direction === "ascending" ? 1 : -1);
  };
  const title = node => node.kind === "group" ? node.title : byId.get(node.layerId)?.title ?? node.layerId;
  target.sort((a, b) => compare(title(a), title(b)));
  const configured = new Set(configuredLayerIds(tree));
  const ordered = uniqueLayers(layers).filter(layer => !configured.has(layer.layerId));
  if (!parentId) ordered.sort((a, b) => compare(a.title ?? a.layerId, b.title ?? b.layerId));
  const seen = new Set(ordered.map(layer => layer.layerId));
  // Traverse the newly sorted tree directly: normalizing against the old Layer
  // ranks here would undo the deliberate sibling sort.
  visitLayerTree(tree, node => {
    if (node.kind !== "layer" || seen.has(node.layerId) || !byId.has(node.layerId)) return;
    seen.add(node.layerId);
    ordered.push(byId.get(node.layerId));
  });
  return {tree, layers: ordered};
}

export function restoreSavedLayerOrder(layers, savedLayers) {
  const output = uniqueLayers(layers);
  if (!Array.isArray(savedLayers)) return output;
  const byId = new Map(output.map((layer) => [layer.layerId, layer]));
  const orderedSaved = [];
  const seen = new Set();
  for (const saved of savedLayers) {
    const layerId = saved?.layerId;
    if (typeof layerId !== "string" || seen.has(layerId) || !byId.has(layerId)) continue;
    seen.add(layerId);
    orderedSaved.push(byId.get(layerId));
  }
  const matchingSlots = output
    .map((layer, index) => seen.has(layer.layerId) ? index : -1)
    .filter((index) => index >= 0);
  matchingSlots.forEach((slot, index) => output.splice(slot, 1, orderedSaved[index]));
  return output;
}

export function layerMoveState(layers, layerTree, layerId) {
  const currentIds = safeLayerIds(layers);
  const configured = new Set(configuredLayerIds(layerTree));
  let segmentIds = null;

  visitSiblingLists(layerTree, (nodes) => {
    if (segmentIds) return;
    const siblingIds = nodes
      .filter((node) => node?.kind === "layer" && currentIds.includes(node.layerId))
      .map(({layerId: siblingId}) => siblingId)
      .sort((left, right) => currentIds.indexOf(left) - currentIds.indexOf(right));
    if (siblingIds.includes(layerId)) segmentIds = siblingIds;
  });
  if (!configured.has(layerId)) segmentIds = currentIds.filter((id) => !configured.has(id));
  segmentIds ??= [];
  const index = segmentIds.indexOf(layerId);
  return {
    segmentIds,
    index,
    canMoveUp: index > 0,
    canMoveDown: index >= 0 && index < segmentIds.length - 1
  };
}

export function reorderedLayerStack(layers, layerTree, layerId, delta) {
  const output = uniqueLayers(layers);
  if (![ -1, 1 ].includes(delta)) return output;
  const move = layerMoveState(output, layerTree, layerId);
  const targetId = move.segmentIds[move.index + delta];
  if (!targetId) return output;
  const sourceIndex = output.findIndex((layer) => layer.layerId === layerId);
  const targetIndex = output.findIndex((layer) => layer.layerId === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return output;
  [output[sourceIndex], output[targetIndex]] = [output[targetIndex], output[sourceIndex]];
  return output;
}

function visitLayerTree(layerTree, visit) {
  let visited = 0;
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > MAX_TREE_DEPTH || visited >= MAX_TREE_NODES) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object" || visited >= MAX_TREE_NODES) continue;
      visited += 1;
      visit(node);
      if (node.kind === "group") walk(node.children, depth + 1);
    }
  };
  walk(layerTree, 0);
}

function visitSiblingLists(layerTree, visit) {
  let visited = 0;
  const walk = (nodes, depth) => {
    if (!Array.isArray(nodes) || depth > MAX_TREE_DEPTH || visited >= MAX_TREE_NODES) return;
    visit(nodes);
    for (const node of nodes) {
      if (!node || typeof node !== "object" || visited >= MAX_TREE_NODES) continue;
      visited += 1;
      if (node.kind === "group") walk(node.children, depth + 1);
    }
  };
  walk(layerTree, 0);
}

function safeLayerIds(layers) {
  return uniqueLayers(layers).map(({layerId}) => layerId);
}

function uniqueLayers(layers) {
  if (!Array.isArray(layers)) return [];
  const output = [];
  const seen = new Set();
  for (const layer of layers) {
    if (!layer || typeof layer.layerId !== "string" || seen.has(layer.layerId)) continue;
    seen.add(layer.layerId);
    output.push(layer);
  }
  return output;
}

// Preserve occurrence order by default; only explicitly raised labels move above data.
export function orderedRenderLayerIds(layers, handles) {
  const ordinary=[], raised=[];
  for(const layer of [...layers].reverse()) {
    const handle=handles.get(layer.layerId);
    for(const id of handle?.layerIds??[]) {
      (layer.labels?.drawOrder==="above-data"&&id===handle.labelLayerId?raised:ordinary).push(id);
    }
  }
  return [...ordinary,...raised];
}
