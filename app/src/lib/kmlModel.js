const KML = "http://www.opengis.net/kml/2.2";
const COLLADA = "http://www.collada.org/2005/11/COLLADASchema";
const modes = new Set(["clampToGround", "relativeToGround", "absolute"]);
export const KML_MODEL_LIMITS = Object.freeze({sourceBytes: 65536, vertices: 3072, sources: 8, triangles: 1024});
const fail = (code, message) => Object.assign(Error(message), {code});
const number = (value, low, high) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high)
    throw fail("kml_model_number", "A Model coordinate, orientation or scale is outside its declared bounds.");
  return value;
};
const child = (node, name) => [...(node?.children ?? [])].find(node => node.localName === name);
const value = (node, name, fallback) => {const text = child(node, name)?.textContent?.trim();return text ? Number(text) : fallback;};
const escape = text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const base64 = bytes => {let text = "";for (const byte of bytes) text += String.fromCharCode(byte);return btoa(text);};
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");

export function normalizeKmlModel(input) {
  if (!input || typeof input !== "object") throw fail("kml_model_required", "Choose a Model definition.");
  const href = input.link?.href;
  if (typeof href !== "string" || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.dae$/i.test(href)
    || href.split("/").some(part => part === "." || part === ".."))
    throw fail("kml_model_local_dae", "Models require a safe same-archive .dae resource; remote fetches are not authorized.");
  const location = input.location ?? {}, orientation = input.orientation ?? {}, scale = input.scale ?? {};
  const altitudeMode = input.altitudeMode ?? "absolute";
  if (!modes.has(altitudeMode)) throw fail("kml_model_altitude_mode", "Choose clampToGround, relativeToGround or absolute Model altitude.");
  if (input.resourceMap?.length) throw fail("kml_model_resource_map", "Textured ResourceMap models are outside this untextured triangle profile; preserve the original archive.");
  return {location: {longitude: number(location.longitude, -180, 180), latitude: number(location.latitude, -90, 90),
    altitude: number(location.altitude ?? 0, -10_000_000, 10_000_000)},
  orientation: {heading: number(orientation.heading ?? 0, -360, 360), tilt: number(orientation.tilt ?? 0, -180, 180),
    roll: number(orientation.roll ?? 0, -180, 180)},
  scale: {x: number(scale.x ?? 1, Number.MIN_VALUE, 1_000_000), y: number(scale.y ?? 1, Number.MIN_VALUE, 1_000_000),
    z: number(scale.z ?? 1, Number.MIN_VALUE, 1_000_000)}, altitudeMode, link: {href}, resourceMap: []};
}

export function parseKmlModelElement(node) {
  const allowed = new Set(["altitudeMode", "Location", "Orientation", "Scale", "Link", "ResourceMap"]);
  if ([...node.children].some(node => node.namespaceURI !== KML || !allowed.has(node.localName)))
    throw fail("kml_model_semantics", "This Model has unsupported child semantics. Keep its original source.");
  const location = child(node, "Location"), orientation = child(node, "Orientation"), scale = child(node, "Scale");
  if (child(node, "ResourceMap")?.children?.length) throw fail("kml_model_resource_map", "Textured ResourceMap models are unsupported.");
  return normalizeKmlModel({location: {longitude: value(location, "longitude", 0), latitude: value(location, "latitude", 0), altitude: value(location, "altitude", 0)},
    orientation: {heading: value(orientation, "heading", 0), tilt: value(orientation, "tilt", 0), roll: value(orientation, "roll", 0)},
    scale: {x: value(scale, "x", 1), y: value(scale, "y", 1), z: value(scale, "z", 1)},
    altitudeMode: child(node, "altitudeMode")?.textContent?.trim() || "clampToGround", link: {href: child(child(node, "Link"), "href")?.textContent?.trim()}});
}

export function writeKmlModel(input, depth = 0) {
  const model = normalizeKmlModel(input), indent = "  ".repeat(depth), lines = [`${indent}<Model>`, `${indent}  <altitudeMode>${model.altitudeMode}</altitudeMode>`];
  for (const [tag, fields] of [["Location", model.location], ["Orientation", model.orientation], ["Scale", model.scale]])
    lines.push(`${indent}  <${tag}>`, ...Object.entries(fields).map(([key, value]) => `${indent}    <${key}>${value}</${key}>`), `${indent}  </${tag}>`);
  lines.push(`${indent}  <Link><href>${escape(model.link.href)}</href></Link>`, `${indent}</Model>`);
  return lines.join("\n");
}

/** One static COLLADA mesh, explicit triangle positions and optional normals.
 * Unsupported transforms/material graphs are refused, never executed or fetched. */
export function readColladaTriangles(text, {DOMParser = globalThis.DOMParser} = {}) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > KML_MODEL_LIMITS.sourceBytes
    || /<!DOCTYPE|<!ENTITY/i.test(text) || typeof DOMParser !== "function")
    throw fail("collada_source", "Choose a local UTF-8 COLLADA file of at most 64 KiB without active XML.");
  const xml = new DOMParser().parseFromString(text, "application/xml"), root = xml.documentElement;
  if (xml.querySelector("parsererror") || root?.localName !== "COLLADA" || root.namespaceURI !== COLLADA
    || !["1.4.0", "1.4.1"].includes(root.getAttribute("version")))
    throw fail("collada_version", "This profile reads static COLLADA 1.4 triangle meshes.");
  if (root.querySelector("image, texture, animation, controller, skin, morph, polylist, polygons, lines, matrix, translate, rotate, scale, lookat, skew, instance_controller"))
    throw fail("collada_semantics", "Textures, animation, non-triangle primitives and scene-node transforms require another reviewed model profile.");
  const geometries = root.querySelectorAll("library_geometries > geometry"), instances = root.querySelectorAll("instance_geometry");
  if (geometries.length !== 1 || instances.length !== 1 || instances[0].getAttribute("url") !== `#${geometries[0].getAttribute("id")}`)
    throw fail("collada_scene", "Choose one explicitly instanced static mesh.");
  const mesh = child(geometries[0], "mesh"), sources = new Map();
  const elements = [...(mesh?.children ?? [])].filter(node => node.localName === "source");
  if (elements.length > KML_MODEL_LIMITS.sources) throw fail("collada_sources", "A Model may have at most eight numeric sources.");
  for (const source of elements) {
    const array = child(source, "float_array"), accessor = source.querySelector("technique_common > accessor");
    const values = array?.textContent?.trim().split(/\s+/).map(Number), count = Number(accessor?.getAttribute("count"));
    if (!values?.length || !values.every(Number.isFinite) || Number(array.getAttribute("count")) !== values.length
      || !Number.isSafeInteger(count) || count < 1 || count > KML_MODEL_LIMITS.vertices
      || Number(accessor.getAttribute("stride")) !== 3 || (accessor.getAttribute("offset") ?? "0") !== "0"
      || accessor.getAttribute("source") !== `#${array.getAttribute("id")}` || values.length !== count * 3 || sources.has(`#${source.id}`))
      throw fail("collada_source_array", "COLLADA position/normal arrays need exact finite XYZ tuples and declared counts.");
    sources.set(`#${source.getAttribute("id")}`, values);
  }
  const vertices = child(mesh, "vertices"), vertexInputs = [...(vertices?.children ?? [])];
  if (vertexInputs.length !== 1 || vertexInputs[0].getAttribute("semantic") !== "POSITION")
    throw fail("collada_vertices", "One explicit POSITION source is required.");
  const positions = sources.get(vertexInputs[0].getAttribute("source")), output = [];
  const triangles = [...(mesh?.children ?? [])].filter(node => node.localName === "triangles");
  if (!positions || !triangles.length) throw fail("collada_triangles", "No supported triangle position source is present.");
  for (const triangle of triangles) {
    const inputs = [...triangle.children].filter(node => node.localName === "input");
    const position = inputs.find(node => node.getAttribute("semantic") === "VERTEX");
    if (!position || position.getAttribute("source") !== `#${vertices.getAttribute("id")}` || inputs.some(node => !["VERTEX", "NORMAL"].includes(node.getAttribute("semantic")))
      || inputs.length > 2 || inputs.some(node => !["0", "1"].includes(node.getAttribute("offset"))))
      throw fail("collada_triangle_inputs", "Only indexed VERTEX and optional NORMAL triangle inputs are admitted.");
    const stride = Math.max(...inputs.map(node => Number(node.getAttribute("offset")))) + 1;
    const normalInput = inputs.find(node => node.getAttribute("semantic") === "NORMAL");
    const normalSource = normalInput && sources.get(normalInput.getAttribute("source"));
    if (normalInput && !normalSource) throw fail("collada_normal_source", "A triangle references a missing normal source.");
    const indices = child(triangle, "p")?.textContent?.trim().split(/\s+/).map(Number), count = Number(triangle.getAttribute("count"));
    if (!Number.isSafeInteger(count) || count < 1 || count > KML_MODEL_LIMITS.triangles || !indices
      || indices.length !== count * 3 * stride || !indices.every(index => Number.isSafeInteger(index) && index >= 0))
      throw fail("collada_triangle_count", "Triangle indices/counts are inconsistent or exceed the mesh budget.");
    for (let index = 0; index < indices.length; index += stride) {
      const at = indices[index + Number(position.getAttribute("offset"))] * 3;
      if (at + 2 >= positions.length) throw fail("collada_position_index", "A triangle references a missing position.");
      if (normalInput && indices[index + Number(normalInput.getAttribute("offset"))] * 3 + 2 >= normalSource.length)
        throw fail("collada_normal_index", "A triangle references a missing normal.");
      output.push(...positions.slice(at, at + 3));
      if (output.length > KML_MODEL_LIMITS.vertices * 3) throw fail("collada_vertex_limit", "The expanded mesh exceeds 3072 vertices.");
    }
  }
  const unit = Number(root.querySelector("asset > unit")?.getAttribute("meter") ?? 1), up = root.querySelector("asset > up_axis")?.textContent?.trim() ?? "Y_UP";
  if (!Number.isFinite(unit) || unit <= 0 || unit > 1_000_000 || !["Y_UP", "Z_UP"].includes(up))
    throw fail("collada_units", "Only explicit metre scaling with Y_UP or Z_UP is supported.");
  const values = new Float32Array(output.length);
  for (let i = 0; i < output.length; i += 3) {
    const [x, y, z] = output.slice(i, i + 3).map(value => value * unit);
    values.set(up === "Z_UP" ? [x, z, -y] : [x, y, z], i);
  }
  if (![...values].every(Number.isFinite)) throw fail("collada_float_range", "Model coordinates exceed the finite native mesh range.");
  return {positions: values, sourceAxis: up, sourceUnitMetres: unit, triangleCount: values.length / 9};
}

/** A small authored box is real portable COLLADA, not a marker substituted for
 * model custody. Size/rotation belong to the separately editable KML Model. */
export function createBoxKmlModel({id = "authored-model", name = "New Model", location,
  orientation, scale, altitudeMode = "absolute", view = null} = {}) {
  if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)
    || typeof name !== "string" || name.length > 256) throw fail("kml_model_identity", "Choose a bounded Model identity and name.");
  const model = normalizeKmlModel({location, orientation, scale, altitudeMode, link: {href: `models/${id}.dae`}});
  const createdAt = new Date().toISOString();
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<COLLADA xmlns="${COLLADA}" version="1.4.1"><asset><created>${createdAt}</created><modified>${createdAt}</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>
<library_geometries><geometry id="box"><mesh><source id="positions"><float_array id="position-values" count="24">-0.5 -0.5 0 0.5 -0.5 0 0.5 0.5 0 -0.5 0.5 0 -0.5 -0.5 1 0.5 -0.5 1 0.5 0.5 1 -0.5 0.5 1</float_array><technique_common><accessor source="#position-values" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices><triangles count="12"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 2 1 0 3 2 4 5 6 4 6 7 0 1 5 0 5 4 1 2 6 1 6 5 2 3 7 2 7 6 3 0 4 3 4 7</p></triangles></mesh></geometry></library_geometries>
<library_visual_scenes><visual_scene id="scene"><node id="box-node"><instance_geometry url="#box"/></node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#scene"/></scene></COLLADA>`;
  const bytes = new TextEncoder().encode(text);
  return {place: {kind: "placemark", id, name, description: null, visibility: true, model,
    geometry: {type: "Point", coordinates: [model.location.longitude, model.location.latitude, model.location.altitude]},
    altitudeMode, view}, resource: {path: model.link.href, mediaType: "model/vnd.collada+xml", byteLength: bytes.length, dataBase64: base64(bytes)}};
}

export async function kmlModelGltf(document, place, options = {}) {
  const model = normalizeKmlModel(place?.model), resource = document?.resources?.find(resource => resource.path === model.link.href);
  if (!resource || resource.mediaType !== "model/vnd.collada+xml") throw fail("kml_model_resource_missing", "The exact local COLLADA resource is unavailable.");
  const bytes = Uint8Array.from(atob(resource.dataBase64), char => char.charCodeAt(0));
  if (bytes.length !== resource.byteLength || bytes.length > KML_MODEL_LIMITS.sourceBytes) throw fail("kml_model_resource_size", "The model resource size is inconsistent.");
  const mesh = readColladaTriangles(new TextDecoder("utf-8", {fatal: true}).decode(bytes), options);
  const positions = mesh.positions, normals = new Float32Array(positions.length);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < positions.length; at += 9) {
    const a = positions.slice(at, at + 3), b = positions.slice(at + 3, at + 6), c = positions.slice(at + 6, at + 9);
    const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...cross);
    if (!length) throw fail("collada_degenerate_triangle", "A model triangle has no surface area.");
    const normal = cross.map(value => value / length);
    for (let vertex = 0; vertex < 3; vertex++) {normals.set(normal, at + vertex * 3);
      for (let axis = 0; axis < 3; axis++) {min[axis] = Math.min(min[axis], positions[at + vertex * 3 + axis]);max[axis] = Math.max(max[axis], positions[at + vertex * 3 + axis]);}}
  }
  const binary = new Uint8Array(positions.byteLength + normals.byteLength);
  binary.set(new Uint8Array(positions.buffer));binary.set(new Uint8Array(normals.buffer), positions.byteLength);
  const gltf = {asset: {version: "2.0", generator: "OpenGeo bounded static COLLADA conversion"}, scene: 0, scenes: [{nodes: [0]}],
    nodes: [{mesh: 0}], meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, material: 0, mode: 4}]}],
    materials: [{doubleSided: true, pbrMetallicRoughness: {baseColorFactor: [0.55, 0.7, 0.9, 1], metallicFactor: 0, roughnessFactor: 1}}],
    buffers: [{byteLength: binary.byteLength, uri: `data:application/octet-stream;base64,${base64(binary)}`}],
    bufferViews: [{buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962},
      {buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962}],
    accessors: [{bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max},
      {bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3"}]};
  const encoded = new TextEncoder().encode(JSON.stringify(gltf));
  return {gltf, uri: `data:model/gltf+json;base64,${base64(encoded)}`, model,
    report: {sourceHref: model.link.href, originalSha256: await digest(bytes), derivedSha256: await digest(encoded),
      sourceAxis: mesh.sourceAxis, sourceUnitMetres: mesh.sourceUnitMetres, triangles: mesh.triangleCount,
      method: "Preserved triangle positions; source metre/up-axis conversion to glTF Y-up; derived flat face normals.",
      losses: ["Original COLLADA bytes retained. Preview uses one neutral material and flat normals; original materials/normals are not portrayed.",
        "Textures, animation, scene-node transforms and external resources are refused."]}};
}

export async function addKmlModelToCesium(C, viewer, {document, place, signal, DOMParser = globalThis.DOMParser} = {}) {
  signal?.throwIfAborted();
  const compiled = await kmlModelGltf(document, place, {DOMParser});signal?.throwIfAborted();
  const {location, orientation, scale} = compiled.model, radians = C.Math.toRadians;
  const cartographic = C.Cartographic.fromDegrees(location.longitude, location.latitude);
  const ground = viewer.scene.globe.getHeight(cartographic);
  if (compiled.model.altitudeMode !== "absolute" && !Number.isFinite(ground))
    throw fail("kml_model_ground_unavailable", "This Model requires a known ground height; choose absolute altitude or load terrain first.");
  const altitude = compiled.model.altitudeMode === "absolute" ? location.altitude
    : ground + (compiled.model.altitudeMode === "relativeToGround" ? location.altitude : 0);
  const rotation = C.Matrix3.multiply(C.Matrix3.fromRotationZ(-radians(orientation.heading)),
    C.Matrix3.multiply(C.Matrix3.fromRotationX(radians(orientation.tilt)), C.Matrix3.fromRotationY(radians(orientation.roll)), new C.Matrix3()), new C.Matrix3());
  const matrix = C.Matrix4.multiply(C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(location.longitude, location.latitude, altitude)),
    C.Matrix4.fromRotationTranslation(rotation), new C.Matrix4());
  C.Matrix4.multiplyByScale(matrix, new C.Cartesian3(scale.x, scale.y, scale.z), matrix);
  const primitive = await C.Model.fromGltfAsync({url: compiled.uri, modelMatrix: matrix, allowPicking: true});
  if (signal?.aborted) {primitive.destroy();signal.throwIfAborted();}
  viewer.scene.primitives.add(primitive);viewer.scene.requestRender();
  let disposed = false;
  return {primitive, report: compiled.report, dispose() {if (disposed) return;disposed = true;
    if (!viewer.isDestroyed?.()) {viewer.scene.primitives.remove(primitive);viewer.scene.requestRender();}}};
}
