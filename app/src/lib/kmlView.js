import engine from "./mapRenderer.js";

const MAX_LATITUDE = 85.0511287798066;
const radians = value => value * Math.PI / 180;
const refusal = (code, message) => ({applied: false, code, message});

// KML Camera/LookAt use metres and degrees. Google documents positive Camera
// roll as rolling left; MapLibre documents positive roll counterclockwise about
// the camera boresight. Both therefore use the same sign, without negation.
// https://developers.google.com/kml/documentation/cameras
// MapLibre 6.4.1 src/ui/map.ts (roll) and src/ui/camera.ts (native calculations).
export function applyKmlView({map, view, engineId, spatialBody}) {
  let previous;
  try {
    if (!view || !["Camera", "LookAt"].includes(view.type)) return refusal("view-invalid", "This KML view type cannot be navigated.");
    if (engineId !== "maplibre" || (spatialBody?.id ?? spatialBody ?? "earth") !== "earth") {
      return refusal("renderer-unsupported", "This KML view needs the Earth MapLibre renderer.");
    }
    const methods = ["jumpTo", "getCenter", "getZoom", "getPitch", "getBearing", "getRoll", "getCenterElevation",
      "getCenterClampedToGround", "setCenterClampedToGround", "getMinZoom", "getMaxZoom", "getMinPitch", "getMaxPitch",
      "getProjection", "getTerrain", "getMaxBounds", "getCanvas",
      view.type === "Camera" ? "calculateCameraOptionsFromCameraLngLatAltRotation" : "calculateCameraOptionsFromTo"];
    if (!map || methods.some(name => typeof map[name] !== "function") || map.getCanvas()?.isConnected === false) {
      return refusal("map-unavailable", "The map is not ready to open this KML view.");
    }
    const projection = map.getProjection();
    if ((projection?.type ?? projection?.name) !== "mercator") return refusal("projection-unsupported", "This KML view needs the Mercator projection; globe camera semantics are not mapped yet.");
    if (map.getMaxBounds() || map.getRenderWorldCopies?.() === false) return refusal("bounds-unsupported", "The current map bounds can change this KML view. Remove those bounds before opening it.");
    // The native cache query returns zero for missing DEM tiles as well as sea
    // level. It cannot certify destination/eye terrain coverage without requests.
    if (map.getTerrain()) return refusal("terrain-unavailable", "Terrain coverage at this KML view cannot be confirmed from the loaded map. Turn terrain off to use its zero-height ground plane.");
    const fields = view.type === "Camera" ? ["longitude", "latitude", "altitude", "heading", "tilt", "roll"] : ["longitude", "latitude", "altitude", "heading", "tilt", "range"];
    if (fields.some(key => view[key] !== undefined && !Number.isFinite(view[key]))) return refusal("view-number-invalid", "The KML view contains an invalid number.");
    const longitude = view.longitude ?? 0, latitude = view.latitude ?? 0;
    const heading = view.heading ?? 0, tilt = view.tilt ?? 0, roll = view.type === "Camera" ? view.roll ?? 0 : 0;
    const mode = view.altitudeMode ?? "clampToGround";
    if (!["absolute", "relativeToGround", "clampToGround"].includes(mode)) return refusal("altitude-mode-unsupported", "Sea-floor altitude modes are retained but cannot be navigated by this renderer.");
    if (Math.abs(longitude) > 180 || Math.abs(latitude) > MAX_LATITUDE || Math.abs(heading) > 360 || Math.abs(roll) > 180) return refusal("view-coordinate-unsupported", "The KML view lies outside this renderer's coordinate or rotation limits.");
    if (tilt < map.getMinPitch() || tilt > Math.min(85, map.getMaxPitch()) || tilt < 0) return refusal("pitch-unsupported", "The KML view tilt exceeds the current map's supported pitch range.");
    // With terrain disabled the current renderer's ground is provably zero.
    // KML Camera treats clampToGround as relativeToGround; LookAt instead
    // ignores its target altitude in clampToGround mode:
    // https://developers.google.com/kml/documentation/kmlreference#camera
    const altitude = mode === "clampToGround" && view.type === "LookAt" ? 0 : view.altitude ?? 0;
    let options, eye;
    if (view.type === "Camera") {
      eye = {longitude, latitude, altitude};
      options = map.calculateCameraOptionsFromCameraLngLatAltRotation([longitude, latitude], altitude, heading, tilt, roll);
    } else {
      const range = view.range ?? 0;
      if (range <= 0) return refusal("range-unsupported", "The KML LookAt range must be greater than zero to position the camera.");
      // The native vertical From/To calculation supplies the exact zoom for this
      // Mercator range. Heading/tilt rotate the eye around the retained target.
      options = {...map.calculateCameraOptionsFromTo([longitude, latitude], altitude + range, [longitude, latitude], altitude), bearing: heading, pitch: tilt, roll: 0};
      const target = engine.MercatorCoordinate.fromLngLat([longitude, latitude], altitude);
      const distance = range * target.meterInMercatorCoordinateUnits();
      const position = new engine.MercatorCoordinate(target.x - distance * Math.sin(radians(tilt)) * Math.sin(radians(heading)),
        target.y + distance * Math.sin(radians(tilt)) * Math.cos(radians(heading))).toLngLat();
      eye = {longitude: position.lng, latitude: position.lat, altitude: altitude + range * Math.cos(radians(tilt))};
    }
    if (![eye.longitude, eye.latitude, eye.altitude].every(Number.isFinite) || Math.abs(eye.latitude) > MAX_LATITUDE || eye.altitude <= 0) return refusal("camera-ground-unsupported", "This KML view places the camera at or below the current ground plane, or beyond supported latitudes.");
    const center = Array.isArray(options?.center) ? options.center : [options?.center?.lng, options?.center?.lat];
    if (![...center, options?.zoom, options?.elevation, options?.bearing, options?.pitch, options?.roll].every(Number.isFinite)
      || Math.abs(center[1]) > MAX_LATITUDE || options.zoom < map.getMinZoom() || options.zoom > map.getMaxZoom()) return refusal("camera-range-unsupported", "This KML view exceeds the current map's camera or zoom limits.");
    const y = engine.MercatorCoordinate.fromLngLat(center).y;
    const halfHeight = (map.getCanvas()?.clientHeight ?? 0) / (2 * 512 * 2 ** options.zoom);
    if (y - halfHeight < 0 || y + halfHeight > 1) return refusal("viewport-unsupported", "This KML view would be shifted by the map's latitude bounds.");
    options = {...options, center};
    previous = cameraSnapshot(map);
    map.setCenterClampedToGround(false);
    // MapLibre 6.4.1 easeTo/flyTo do not honor explicit target elevation.
    map.jumpTo(options);
    if (map.getCenterClampedToGround() !== false || !sameCamera(cameraSnapshot(map), options)) throw Error("The map adjusted the requested camera.");
    return {applied: true, options, message: mode === "absolute" ? "Opened the saved KML view." : "Opened the saved KML view using the map's zero-height ground plane."};
  } catch {
    if (previous) {
      try {map.setCenterClampedToGround(previous.centerClampedToGround); map.jumpTo(previous);} catch { /* A removed renderer has no remaining camera to restore. */ }
    }
    return refusal("camera-unsupported", "This map cannot retain the requested KML camera. The saved view is unchanged.");
  }
}

function cameraSnapshot(map) {
  const center = map.getCenter();
  return {center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), roll: map.getRoll(),
    elevation: map.getCenterElevation(), centerClampedToGround: map.getCenterClampedToGround()};
}

function sameCamera(actual, expected) {
  const longitudeDelta = ((actual.center[0] - expected.center[0] + 540) % 360) - 180;
  const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
  return Math.abs(longitudeDelta) < 1e-6 && Math.abs(actual.center[1] - expected.center[1]) < 1e-6
    && ["zoom", "pitch", "elevation"].every(key => Math.abs(actual[key] - expected[key]) < 1e-6)
    && ["bearing", "roll"].every(key => Math.abs(angleDelta(actual[key], expected[key])) < 1e-6);
}
