import {itemBounds, publicItemUrl, STATIC_ITEM_ADAPTER} from "./staticItemSearch.js";

// Metadata registration only. Provider pixels are read by a separate deliberate preview.
export function cogSourceFromStaticItem(reference, {assetKey = "visual", title = reference.id, attribution = null} = {}) {
  if (reference.adapter !== STATIC_ITEM_ADAPTER || reference.custody !== "referenced"
    || !reference.id || !reference.collectionId || !reference.snapshot?.etag) throw Error("Select a current public scene reference first.");
  const asset = reference.assets?.find(asset => asset.key === assetKey);
  if (!asset || !asset.type?.includes("tiff") || !asset.original
    || publicItemUrl(asset.original.href, reference.snapshot.url) !== asset.href) throw Error("Choose a TIFF asset from this scene.");
  const url = publicItemUrl(asset.href), parsed = new URL(url);
  if (parsed.search || !/\.tiff?$/i.test(parsed.pathname)) throw Error("The COG reference must be a query-free TIFF object.");
  const declaredBands = asset.original["raster:bands"] ?? asset.bands;
  const bands = Array.isArray(declaredBands) && declaredBands.length === 1 ? [1] : [1, 2, 3];
  const referenceMetadata = {
    schemaVersion: "opengeo.cog-reference.1", custody: "referenced",
    source: {collectionId: reference.collectionId, itemId: reference.id, datetime: reference.datetime,
      geometry: structuredClone(reference.original.geometry ?? null), assetKey, asset: structuredClone(asset.original),
      assets: structuredClone(reference.original.assets), links: structuredClone(reference.original.links ?? [])},
    normalized: {assetHref: url, reader: reference.inventory.reader, adapter: reference.adapter,
      snapshot: structuredClone(reference.snapshot), inventory: structuredClone(reference.inventory)},
    curated: {}, inferred: {}
  };
  return {name: String(title).trim(), description: `${reference.collectionId}/${reference.id} · upstream raster reference`,
    classification: "internal", tags: ["cog", "external-source", "sentinel-2"],
    source: {type: "cog", url, bands, bounds: itemBounds(reference.bbox),
      sizeBytes: asset.original["file:size"] ?? null, license: asset.license ?? null,
      attribution, referenceMetadata}};
}

export async function registerStaticCogReference({adapter, projectId, reference, options, context = null, isCurrent = () => true}) {
  const current = async () => {
    if (!isCurrent()) throw Error("This Catalog view changed. Reopen it before registering.");
    if (context) await adapter.assertCollectionContext(context);
    if (!isCurrent()) throw Error("This Catalog view changed. Reopen it before registering.");
  };
  const draft = cogSourceFromStaticItem(reference, options);
  await current();
  // Search only this known upstream identity; no account-wide source scan.
  const candidates = await adapter.searchDatasets({query: reference.id, projectId, limit: 21, offset: 0});
  await current();
  if (candidates.length > 20) throw Error("Too many matching Catalog records. Find the existing Layer in Catalog before registering again.");
  for (const candidate of candidates.filter(candidate => candidate.sourceType === "cog")) {
    const source = await adapter.getSource(projectId, candidate.id); await current();
    const metadata = source.configuration.referenceMetadata?.source;
    if (source.status === "active" && source.sourceUrl === draft.source.url
      && metadata?.itemId === reference.id && metadata?.collectionId === reference.collectionId
      && metadata?.assetKey === (options?.assetKey ?? "visual")
      && JSON.stringify(source.configuration.bands) === JSON.stringify(draft.source.bands)) return {source, reused: true};
  }
  await current();
  const source = await adapter.createSource(projectId, draft, {context});
  // A committed write can survive a detached view. Never retry it automatically.
  await current();
  return {source, reused: false};
}
