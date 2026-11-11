export const PANORAMA_SCHEMA = "opengeo.panorama.1.0.0";
export const PANORAMA_LIMITS = Object.freeze({scenes: 16, imageBytes: 1048576, totalBytes: 4194304, width: 4096, height: 2048, links: 8});

const fail = code => {throw Object.assign(Error(code), {code});};
const text = (value, length, code) => typeof value === "string" && value.trim() && value.length <= length ? value.trim() : fail(code);
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : fail("panorama_identity_invalid");
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max ? value : fail("panorama_camera_invalid");
const heading = value => ((number(value, -36000, 36000) % 360) + 360) % 360;

export function panoramaImageDimensions(bytes, mediaType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height;
  if (mediaType === "image/png") {
    if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) fail("panorama_image_invalid");
    width = view.getUint32(16);height = view.getUint32(20);
  } else {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 255) fail("panorama_image_invalid");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) fail("panorama_image_invalid");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {if (length < 8) fail("panorama_image_invalid");height = view.getUint16(offset + 3);width = view.getUint16(offset + 5);break;}
      offset += length;
    }
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 1 || width > PANORAMA_LIMITS.width
    || height > PANORAMA_LIMITS.height || width !== height * 2) fail("panorama_projection_invalid");
  return {width, height};
}

export function normalizePanoramaPose(value = {}) {
  return {heading: heading(value.heading ?? 0), pitch: number(value.pitch ?? 0, -85, 85), fov: number(value.fov ?? 75, 30, 110)};
}

export function panoramaImageBytes(asset) {
  if (!asset || !["image/png", "image/jpeg"].includes(asset.mediaType)
    || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "") || typeof asset.dataUrl !== "string"
    || asset.dataUrl.length > Math.ceil(PANORAMA_LIMITS.imageBytes / 3) * 4 + 64) fail("panorama_asset_invalid");
  const prefix = `data:${asset.mediaType};base64,`;
  if (!asset.dataUrl.startsWith(prefix)) fail("panorama_asset_invalid");
  const encoded = asset.dataUrl.slice(prefix.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail("panorama_asset_invalid");
  let bytes;
  try {bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));} catch {fail("panorama_asset_invalid");}
  if (!bytes.length || bytes.length > PANORAMA_LIMITS.imageBytes) fail("panorama_asset_limit");
  const png = [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (asset.mediaType === "image/png" ? !png : !jpeg) fail("panorama_image_invalid");
  const dimensions = panoramaImageDimensions(bytes, asset.mediaType);
  if (dimensions.width !== asset.width || dimensions.height !== asset.height) fail("panorama_dimensions_mismatch");
  return bytes;
}

export function normalizePanoramaScene(value) {
  if (!value || typeof value !== "object") fail("panorama_scene_invalid");
  const sceneId = id(value.id);
  const position = value.position;
  if (!Array.isArray(position) || position.length !== 2) fail("panorama_position_invalid");
  number(position[0], -180, 180); number(position[1], -90, 90);
  const width = number(value.asset?.width, 2, PANORAMA_LIMITS.width), height = number(value.asset?.height, 1, PANORAMA_LIMITS.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width !== height * 2) fail("panorama_projection_invalid");
  panoramaImageBytes(value.asset);
  if (!value.rights || value.rights.privacyReviewed !== true) fail("panorama_privacy_review_required");
  const links = value.links ?? [];
  if (!Array.isArray(links) || links.length > PANORAMA_LIMITS.links) fail("panorama_link_limit");
  const normalizedLinks = links.map(link => ({sceneId: id(link.sceneId), heading: heading(link.heading ?? 0)}));
  if (new Set(normalizedLinks.map(link => link.sceneId)).size !== links.length || normalizedLinks.some(link => link.sceneId === sceneId)) fail("panorama_link_invalid");
  return {id: sceneId, title: text(value.title, 256, "panorama_title_invalid"), position: [...position],
    asset: {mediaType: value.asset.mediaType, dataUrl: value.asset.dataUrl, sha256: value.asset.sha256, width, height},
    rights: {attribution: text(value.rights.attribution, 1024, "panorama_attribution_required"),
      license: text(value.rights.license, 1024, "panorama_license_required"), privacyReviewed: true, exportAllowed: value.rights.exportAllowed === true},
    initialPose: normalizePanoramaPose(value.initialPose), links: normalizedLinks};
}

export function normalizePanoramaCatalog(value) {
  if (!value) return {schemaVersion: PANORAMA_SCHEMA, scenes: []};
  if (value.schemaVersion !== PANORAMA_SCHEMA || !Array.isArray(value.scenes) || value.scenes.length > PANORAMA_LIMITS.scenes) fail("panorama_catalog_invalid");
  const scenes = value.scenes.map(normalizePanoramaScene);
  if (new Set(scenes.map(scene => scene.id)).size !== scenes.length) fail("panorama_identity_collision");
  if (scenes.reduce((total, scene) => total + panoramaImageBytes(scene.asset).length, 0) > PANORAMA_LIMITS.totalBytes) fail("panorama_catalog_limit");
  const ids = new Set(scenes.map(scene => scene.id));
  if (scenes.some(scene => scene.links.some(link => !ids.has(link.sceneId)))) fail("panorama_link_missing");
  return {schemaVersion: PANORAMA_SCHEMA, scenes};
}

export function normalizePanoramaState(value, catalog) {
  if (value == null) return null;
  const normalized = normalizePanoramaCatalog(catalog);
  const sceneId = id(value.sceneId);
  if (!normalized.scenes.some(scene => scene.id === sceneId)) fail("panorama_coverage_unavailable");
  return {sceneId, ...normalizePanoramaPose(value)};
}

export function panoramaForProject(project) {
  try {
    const catalog = normalizePanoramaCatalog(project?.extensions?.panoramas);
    return {catalog, view: normalizePanoramaState(project?.extensions?.panoramaView, catalog), error: null};
  } catch (error) {
    // Keep invalid source extensions in the Project; opening never erases them.
    return {catalog: {schemaVersion: PANORAMA_SCHEMA, scenes: []}, view: null, error: error.code ?? "panorama_catalog_invalid"};
  }
}

export async function verifyPanoramaScene(value) {
  const scene = normalizePanoramaScene(value), bytes = panoramaImageBytes(scene.asset);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== scene.asset.sha256) fail("panorama_asset_checksum_mismatch");
  return scene;
}

export async function panoramaFromImageFile(file, {id: sceneId, title, position, rights, initialPose} = {}) {
  if (!file || !["image/png", "image/jpeg"].includes(file.type) || file.size < 1 || file.size > PANORAMA_LIMITS.imageBytes) fail("panorama_asset_limit");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) fail("panorama_asset_invalid");
  // Inspect bounded headers before a browser decoder allocates a pixel surface.
  const {width, height} = panoramaImageDimensions(bytes, file.type);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return normalizePanoramaScene({id: sceneId, title, position, rights, initialPose, links: [],
    asset: {mediaType: file.type, width, height, sha256, dataUrl: `data:${file.type};base64,${btoa(binary)}`}});
}

export function panoramaForExport(catalog) {
  const normalized = normalizePanoramaCatalog(catalog);
  if (normalized.scenes.some(scene => !scene.rights.exportAllowed)) fail("panorama_export_review_required");
  return normalized;
}
