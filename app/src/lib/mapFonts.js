export const PINNED_MAP_FONT = Object.freeze({
  id: "opengeo-open-sans-v1", version: 1,
  manifestChecksumSha256: "19aa88722c18ee3005c64d95cded9eda8337d5772939a92e44c53defc930508a"
});
export const PINNED_MAP_FONT_STACK = "OpenGeo Open Sans v1";
const SCHEME = "opengeo-font";
const CHECKSUM = /^[a-f0-9]{64}$/;
const protocolAssets = new Map();
const registeredEngines = new WeakSet();

function fail(code) { throw Object.assign(new Error(code), {code}); }

export function validateMapFontRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "id,manifestChecksumSha256,version"
    || typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > 2_147_483_647
    || !CHECKSUM.test(value.manifestChecksumSha256)) fail("map_font_ref_invalid");
  return value;
}

export function isRegisteredMapFont(value) {
  try { validateMapFontRef(value); } catch { return false; }
  return Object.keys(PINNED_MAP_FONT).every(key => value[key] === PINNED_MAP_FONT[key]);
}

export async function mapFontSha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
}

export function mapLabelTextValues(layer, geojson) {
  const labels = layer.labels ?? {};
  const stringify = value => value === null || value === undefined ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return (geojson?.features ?? []).map(feature =>
    `${labels.prefix ?? ""}${stringify(feature.properties?.[labels.field])}${labels.suffix ?? ""}`);
}

export function registerMapFontProtocol(engine) {
  if (registeredEngines.has(engine)) return;
  engine.addProtocol(SCHEME, async ({url}) => {
    const bytes = protocolAssets.get(url);
    if (!bytes) fail("map_font_glyph_unavailable");
    // MapLibre transfers the returned buffer; never detach the verified cache.
    return {data: bytes.slice().buffer};
  });
  registeredEngines.add(engine);
}

export function createMapFontSession(attachments = null) {
  let manifest = null, loading = null, error = null, phase = "unloaded", routed = false;
  let template = null;
  const assets = new Map();
  const assetUrls = new Map();
  const codepoints = new Set();
  const glyphUrl = range => `${SCHEME}://${PINNED_MAP_FONT.manifestChecksumSha256}/${range}.pbf`;
  const ownTemplate = `${SCHEME}://${PINNED_MAP_FONT.manifestChecksumSha256}/{fontstack}/{range}.pbf`;
  const session = {
    get phase() { return phase; },
    get error() { return error; },
    get available() { return Boolean(attachments); },
    get fontStack() { return PINNED_MAP_FONT_STACK; },
    get usesPinnedGlyphRoot() { return template?.startsWith(`${SCHEME}://`) === true; },
    supportsRenderer(id) {
      return phase === "ready" && (id === "maplibre" || (id === "mapbox" && assetUrls.size === assets.size));
    },
    ownsGlyphTemplate(value) { return value === ownTemplate; },
    async prepare({retry = false} = {}) {
      if (phase === "ready") return manifest;
      if (loading && !retry) return loading;
      if (!attachments) fail("map_font_assets_not_packaged");
      phase = "loading";
      error = null;
      loading = (async () => {
        const bytes = new Uint8Array(await attachments.manifest());
        if (bytes.byteLength > 128_000 || await mapFontSha256(bytes) !== PINNED_MAP_FONT.manifestChecksumSha256) fail("map_font_manifest_mismatch");
        const candidate = JSON.parse(new TextDecoder().decode(bytes));
        if (candidate.schema !== "opengeo.glyph-manifest.1.0.0" || candidate.id !== PINNED_MAP_FONT.id
          || candidate.version !== PINNED_MAP_FONT.version || candidate.fontStack !== PINNED_MAP_FONT_STACK
          || !Array.isArray(candidate.codepoints) || !Array.isArray(candidate.ranges)) fail("map_font_manifest_invalid");
        // This exact, registered manifest was checked against every PBF glyph ID
        // by the asset tests. Verify all bytes before any symbol can use it.
        const loaded = await Promise.all(candidate.ranges.map(async entry => {
          if (!/^[0-9]+-[0-9]+$/.test(entry.range) || !CHECKSUM.test(entry.checksumSha256)
            || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > 1_000_000) fail("map_font_range_invalid");
          const buffer = new Uint8Array(await attachments.range(entry.range));
          if (buffer.byteLength !== entry.sizeBytes || await mapFontSha256(buffer) !== entry.checksumSha256) fail("map_font_glyph_mismatch");
          // HTTP-only SDKs reuse the same packaged asset. Missing/unsafe URLs
          // must not break MapLibre's verified in-memory transport.
          let url = null;
          try {
            const reference = await attachments.rangeUrl?.(entry.range);
            if (typeof reference !== "string" || !reference) throw Error("map_font_url_missing");
            const candidate = new URL(reference, globalThis.location?.href);
            if (["http:", "https:"].includes(candidate.protocol)
              && candidate.origin === globalThis.location?.origin
              && !candidate.username && !candidate.password && !candidate.search && !candidate.hash) url = candidate.href;
          } catch { /* This engine can still use the verified protocol bytes. */ }
          return [entry.range, buffer, url];
        }));
        for (const [range, bytes, url] of loaded) {
          assets.set(range, bytes);
          if (url) assetUrls.set(range, url);
          protocolAssets.set(glyphUrl(range), bytes);
        }
        for (const codepoint of candidate.codepoints) codepoints.add(codepoint);
        manifest = candidate;
        phase = "ready";
        return manifest;
      })().catch(cause => { phase = "failed"; error = cause.code ?? "map_font_load_failed"; throw cause; });
      return loading;
    },
    coverageError(layer, geojson) {
      if (!isRegisteredMapFont(layer.labels?.fontRef)) return "map_font_unregistered";
      if (phase !== "ready") return error ?? "map_font_not_ready";
      if (!geojson) return "map_font_source_not_ready";
      for (const value of mapLabelTextValues(layer, geojson)) for (const char of value) {
        const id = char.codePointAt(0);
        if (id === 10) continue; // A line break is layout, not a glyph.
        if (!codepoints.has(id)) return `map_font_coverage_missing:U+${id.toString(16).toUpperCase().padStart(4, "0")}`;
      }
      return null;
    },
    canRender(layer, geojson) { return routed && !session.coverageError(layer, geojson); },
    configure(map, layers, rendererId = "maplibre") {
      if (!map?.getGlyphs || !map?.setGlyphs) { routed = false; return; }
      const current = map.getGlyphs() ?? null;
      const own = typeof current === "string" && current.startsWith(`${SCHEME}://`);
      if (!own && !layers.some(layer => layer.visible !== false && layer.labels?.enabled && layer.labels?.fontRef)) {
        routed = false;
        template = null;
        return;
      }
      const providerTemplate = current && !own ? current : null;
      const enabled = layers.filter(layer => layer.visible !== false && layer.labels?.enabled && layer.labels?.field);
      const allPinned = enabled.length > 0 && enabled.every(layer => isRegisteredMapFont(layer.labels.fontRef));
      routed = session.supportsRenderer(rendererId) && (Boolean(providerTemplate) || allPinned);
      template = providerTemplate ?? (routed ? ownTemplate : null);
      // Provider glyph templates and their CJK behavior are never replaced.
      // On a blank map, do not change the meaning of unspecified legacy fonts.
      if (!providerTemplate && current !== template) map.setGlyphs(template);
    },
    transformRequest(url, type, delegate, rendererId = "maplibre") {
      if (routed && type === "Glyphs" && template) {
        for (const range of assets.keys()) {
          const expected = template.replace("{fontstack}", PINNED_MAP_FONT_STACK).replace("{range}", range);
          if (url === expected || url === encodeURI(expected)) {
            if (!session.supportsRenderer(rendererId)) fail("map_font_transport_unavailable");
            return {url: rendererId === "mapbox" ? assetUrls.get(range) : glyphUrl(range), credentials: "omit"};
          }
        }
      }
      return delegate(url, type);
    }
  };
  return session;
}
