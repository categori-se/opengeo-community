// KML source attributes remain literal strings. Unknown units and malformed
// coordinates can be exported again without inventing usable icon alignment.
export function normalizeKmlHotSpot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("kml_hotspot_invalid");
  if (Object.keys(value).some(key => !["x", "y", "xunits", "yunits"].includes(key))) {
    throw new Error("kml_hotspot_attribute_invalid");
  }
  const output = {};
  for (const key of ["x", "y", "xunits", "yunits"]) {
    if (!Object.hasOwn(value, key)) continue;
    const raw = value[key];
    if (!(typeof raw === "string" || typeof raw === "number" && Number.isFinite(raw))) {
      throw new Error("kml_hotspot_attribute_invalid");
    }
    const text = String(raw);
    if (text.length > 128) throw new Error("kml_hotspot_attribute_too_long");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) {
      throw new Error("kml_hotspot_attribute_invalid");
    }
    output[key] = text;
  }
  return output;
}

// A saved Place identity selects stable random channels within the source RGB
// component bounds. The original ABGR/colorMode stay intact for interchange.
export function kmlColorPresentation(color, colorMode = "normal", seed = "") {
  if (color === undefined && colorMode === "random") color = "ffffffff";
  if (!/^[0-9a-fA-F]{8}$/.test(color ?? "")) return {};
  let components = [color.slice(6, 8), color.slice(4, 6), color.slice(2, 4)];
  if (colorMode === "random") {
    components = components.map((component, index) => {
      let hash = 2166136261;
      const identity = `${seed}:${index}`;
      for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
      // Avalanche correlated Place IDs before choosing the channel intensity.
      hash ^= hash >>> 16;
      hash = Math.imul(hash, 0x7feb352d);
      hash ^= hash >>> 15;
      hash = Math.imul(hash, 0x846ca68b);
      hash ^= hash >>> 16;
      return Math.floor((hash >>> 0) / 4294967296 * (Number.parseInt(component, 16) + 1))
        .toString(16).padStart(2, "0");
    });
  }
  return {
    kmlColor: `#${components.join("")}`,
    kmlOpacity: Math.round(Number.parseInt(color.slice(0, 2), 16) / 255 * 1_000_000) / 1_000_000
  };
}
