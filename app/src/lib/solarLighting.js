import {OPEN_TERRAIN_SOURCE} from "./terrainView.js";

export const SOLAR_LIGHTING_MODEL = Object.freeze({id: "usno-approximate-geocentric-1", startYear: 1800, endYear: 2200,
  accuracyDegrees: 0.1, reference: "https://aa.usno.navy.mil/faq/sun_approx",
  limits: "Geocentric geometric position, UTC treated as UT1; no atmospheric refraction or cast-shadow/irradiance prediction."});
const layerId = "opengeo-solar-landscape-lighting";
const radians = value => value * Math.PI / 180;
const degrees = value => value * 180 / Math.PI;
const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;

export function landscapeSunPosition(dateTime, longitude, latitude) {
  const time = new Date(dateTime), year = time.getUTCFullYear();
  if (!Number.isFinite(time.getTime()) || year < 1800 || year > 2200 || !Number.isFinite(longitude) || !Number.isFinite(latitude)
    || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw Error("sunlight_scope_invalid");
  // U.S. Naval Observatory approximate solar coordinates, not copied ephemeris data.
  const days = time.getTime() / 86400000 + 2440587.5 - 2451545;
  const anomaly = radians(wrap(357.529 + 0.98560028 * days));
  const ecliptic = radians(wrap(280.459 + 0.98564736 * days + 1.915 * Math.sin(anomaly) + 0.020 * Math.sin(2 * anomaly)));
  const obliquity = radians(23.439 - 0.00000036 * days);
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(ecliptic), Math.cos(ecliptic));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(ecliptic));
  const sidereal = radians(wrap(280.46061837 + 360.98564736629 * days));
  const hourAngle = radians(wrap(longitude + degrees(sidereal - rightAscension))), lat = radians(latitude);
  const elevation = degrees(Math.asin(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)));
  const azimuth = (degrees(Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat))) + 180 + 360) % 360;
  return {dateTime: time.toISOString(), longitude, latitude, azimuth, elevation, model: SOLAR_LIGHTING_MODEL.id,
    declaredAccuracyDegrees: SOLAR_LIGHTING_MODEL.accuracyDegrees};
}

export function createSolarLightingSession(getMap) {
  let original = null, activeMap = null;
  const stop = () => {
    if (!activeMap) return;
    try {if (activeMap.getLayer(layerId)) activeMap.removeLayer(layerId);if (original) activeMap.setLight(original);} catch { /* Replaced renderer retains its own cleanup. */ }
    activeMap = original = null;
  };
  return {stop, dispose: stop, apply(dateTime) {
    const map = getMap();if (!map || !map.getSource(OPEN_TERRAIN_SOURCE.sourceId)) throw Error("sunlight_terrain_required");
    const center = map.getCenter(), sun = landscapeSunPosition(dateTime, center.lng, center.lat);
    if (activeMap !== map) {stop();original = structuredClone(map.getLight());activeMap = map;}
    const day = sun.elevation > 0;
    map.setLight({anchor: "map", color: day ? "#fff4df" : "#26334d", intensity: day ? 0.65 : 0.08,
      position: [1.5, sun.azimuth, Math.max(0, Math.min(180, 90 - sun.elevation))]});
    const paint = {"hillshade-method": "basic", "hillshade-illumination-anchor": "map", "hillshade-illumination-direction": Math.round(sun.azimuth) % 360,
      "hillshade-illumination-altitude": Math.max(0, Math.min(90, sun.elevation)), "hillshade-exaggeration": 0.7,
      "hillshade-shadow-color": day ? "rgba(12,20,36,0.65)" : "rgba(4,10,24,0.9)",
      "hillshade-highlight-color": day ? "rgba(255,250,220,0.35)" : "rgba(4,10,24,0.9)", "hillshade-accent-color": "rgba(0,0,0,0)"};
    if (!map.getLayer(layerId)) {
      const before = map.getStyle().layers.find(layer => !["background", "raster", "hillshade"].includes(layer.type))?.id;
      map.addLayer({id: layerId, type: "hillshade", source: OPEN_TERRAIN_SOURCE.sourceId, paint}, before);
    } else for (const [key, value] of Object.entries(paint)) map.setPaintProperty(layerId, key, value);
    map.triggerRepaint();return sun;
  }};
}
