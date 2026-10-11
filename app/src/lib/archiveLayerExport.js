import {zipSync, strToU8} from "fflate";

/** Package an explicit data export with its reviewed capture identity. No network work. */
export async function archiveLayerExport(exported, collection, layer) {
  const capture = collection?.opengeo;
  if (capture?.sourceMode !== "reviewed-archive") return exported;
  if (capture.authoritativeUrl !== layer.sourceUrl || capture.sourceVersion !== layer.sourceVersion) {
    throw new Error("Archive export source identity changed");
  }
  const data = typeof exported.content === "string" ? strToU8(exported.content)
    : exported.content instanceof ArrayBuffer ? new Uint8Array(exported.content)
    : new Uint8Array(exported.content.buffer, exported.content.byteOffset, exported.content.byteLength);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  const filename = `data${exported.extension}`;
  if (!/^data\.(geojson|json|wkt|wkb|ewkb)$/.test(filename)) throw new Error("Unsupported archive export format");
  const metadata = {
    schemaVersion: "opengeo.archive-layer-export.1",
    layer: {id: layer.layerId, datasetId: layer.datasetId, title: layer.title},
    capture: {
      archiveId: capture.archiveId, capturedAt: capture.capturedAt,
      authoritativeUrl: capture.authoritativeUrl, sourceVersion: capture.sourceVersion,
      unlocatedFeatureCount: capture.unlocatedFeatureCount ?? 0,
      attribution: capture.attribution, rights: capture.rights, provenance: capture.provenance,
      objects: capture.objects.map(({bucket, key, versionId, sha256, decodedSha256}) =>
        ({bucket, key, versionId, sha256, decodedSha256}))
    },
    export: {filename, sha256, bytes: data.byteLength, report: exported.report},
    notes: ["This is an export of the selected archived copy, not a current provider snapshot.",
      "The export checksum describes the converted data file; object checksums describe preserved originals."]
  };
  const serialized = JSON.stringify(metadata, null, 2);
  // Tickets never belong in portable provenance, including nested operator metadata.
  if (/X-Amz-(Signature|Credential|Security-Token)|[?&](access_token|token|sig)=/i.test(serialized)) {
    throw new Error("Temporary credentials cannot be exported");
  }
  return {...exported, content: zipSync({[filename]: data, "provenance.json": strToU8(serialized + "\n")}, {level: 0}),
    extension: ".zip", mediaType: "application/zip", includesArchiveProvenance: true};
}
