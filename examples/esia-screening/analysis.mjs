// Fixture calculation only. This does not fabricate a native screening receipt.
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import GeoJSON from "../../app/node_modules/ol/format/GeoJSON.js";

const provenance = JSON.parse(readFileSync(new URL("./provenance.json", import.meta.url)));
const inputs = {};
for (const [role, record] of Object.entries(provenance.inputFiles)) {
  const bytes = readFileSync(new URL(record.path, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw Error(`Changed ${role} fixture: review its version and expected results first.`);
  }
  inputs[role] = JSON.parse(bytes);
  if (inputs[role].type !== "FeatureCollection"
    || inputs[role].features.length !== record.features) throw Error(`Invalid ${role} fixture.`);
}

const reader = new GeoJSON(), scopes = {}, unique = new Set();
for (const scope of ["footprint", "influence"]) {
  const geometry = reader.readGeometry(inputs[scope].features[0].geometry);
  if (geometry.getType() !== "Polygon") throw Error("The fixture mask must be a Polygon.");
  const selected = inputs.receptors.features.filter(feature => {
    if (feature.geometry.type !== "Point") throw Error("The fixture receptor must be a Point.");
    return geometry.intersectsCoordinate(feature.geometry.coordinates);
  });
  const names = selected.map(feature => feature.properties.name);
  if (JSON.stringify(names) !== JSON.stringify(provenance.expected[`${scope}Points`])) {
    throw Error(`Unexpected ${scope} point membership.`);
  }
  selected.forEach(feature => unique.add(feature.id));
  scopes[scope] = {featureCount: selected.length, pointCount: selected.length, names};
}
const screeningRows = scopes.footprint.featureCount + scopes.influence.featureCount;
if (screeningRows !== provenance.expected.screeningRows
  || unique.size !== provenance.expected.uniqueScreenedPoints) throw Error("Unexpected fixture counts.");
console.log(JSON.stringify({
  fixtureVersion: provenance.fixtureVersion,
  sourcePoints: inputs.receptors.features.length,
  scopes,
  screeningRows,
  uniqueScreenedPoints: unique.size,
  method: provenance.methods.localCheck,
  nativeApiOrPersistenceVerified: false,
}, null, 2));
