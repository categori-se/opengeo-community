import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {PINNED_MAP_FONT, PINNED_MAP_FONT_STACK} from "../src/lib/mapFonts.js";

export const FONT_ROUTE = "/__local-map-fonts/";
export const FONT_LABELS = Object.freeze(["MiXeD Café Ω", "Москва\nΔέλτα", "Conservation Ω"]);
// Large enough for solid glyph interiors in the exact 320 × 240 PNG witness;
// the six-pixel halo also stays within one quarter of the selected text size.
export const FONT_LABEL_SIZE = 24;
export const FONT_COMPOSITION_PROBES = Object.freeze([[-72.49, 42.09], [-72.3, 42.075], [-72.45, 42.075]]);
const digest = value => createHash("sha256").update(value).digest("hex");

export function integratedStudioFontMode(args) {
  assert.ok(args.length === 0 || args.length === 1 && args[0] === "--pinned-map-fonts", "Only --pinned-map-fonts is supported after the evidence directory");
  return args.length === 1;
}

export function loadIntegratedStudioFontAssets(root) {
  const relative = "app/src/assets/render-fonts/opengeo-open-sans-v1/1";
  const manifestBytes = readFileSync(join(root, relative, "manifest.json"));
  assert.equal(digest(manifestBytes), PINNED_MAP_FONT.manifestChecksumSha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.id, PINNED_MAP_FONT.id);
  assert.equal(manifest.version, PINNED_MAP_FONT.version);
  assert.equal(manifest.fontStack, PINNED_MAP_FONT_STACK);
  assert.equal(manifest.codepoints.length, 883);
  const files = new Map([[`${FONT_ROUTE}manifest.json`, {bytes: manifestBytes, contentType: "application/json"}]]);
  const evidence = [{path: `${relative}/manifest.json`, sha256: digest(manifestBytes), bytes: manifestBytes.length}];
  for (const range of manifest.ranges) {
    assert.match(range.range, /^\d+-\d+$/);
    const filename = `${range.range}.pbf`;
    const bytes = readFileSync(join(root, relative, filename));
    assert.equal(bytes.length, range.sizeBytes);
    assert.equal(digest(bytes), range.checksumSha256);
    files.set(`${FONT_ROUTE}${filename}`, {bytes, contentType: "application/x-protobuf"});
    evidence.push({path: `${relative}/${filename}`, sha256: digest(bytes), bytes: bytes.length});
  }
  for (const filename of ["LICENSE.txt", "NOTICE.txt"]) {
    const bytes = readFileSync(join(root, relative, filename));
    if (filename === "LICENSE.txt") assert.equal(digest(bytes), manifest.licenseSha256);
    else assert.match(bytes.toString(), /copyright.*Google/i);
    evidence.push({path: `${relative}/${filename}`, sha256: digest(bytes), bytes: bytes.length});
  }
  const packagePath = "app/node_modules/maplibre-gl/package.json";
  const sourcePath = "app/node_modules/maplibre-gl/dist/maplibre-gl.js";
  const packageBytes = readFileSync(join(root, packagePath));
  const engineBytes = readFileSync(join(root, sourcePath));
  const version = JSON.parse(packageBytes).version;
  assert.equal(version, "5.24.0", "This acceptance requires the reviewed MapLibre engine, not an inferred replacement");
  return {files, evidence, fontRef: {...PINNED_MAP_FONT}, fontStack: PINNED_MAP_FONT_STACK,
    ranges: manifest.ranges.map(entry => entry.range),
    maplibre: {version, sourcePath, sha256: digest(engineBytes), packagePath, packageSha256: digest(packageBytes)}};
}

// This replaces only the harness's static-file transport. Production Workbench
// and mapFonts still own adoption, identity, byte checks, coverage and routing.
export function integratedStudioFontTransport(ranges) {
  return `const readFont = async path => {
    const response = await fetch(path, {credentials:'omit'});
    if (!response.ok) throw new Error('Local pinned font read failed');
    return response.arrayBuffer();
  };
  const fontRanges = new Set(${JSON.stringify(ranges)});
  const mapFontAttachments = {
    manifest: () => readFont('${FONT_ROUTE}manifest.json'),
    range: range => {
      if (!fontRanges.has(range)) throw new Error('Unregistered local font range');
      return readFont('${FONT_ROUTE}' + range + '.pbf');
    }
  };`;
}
