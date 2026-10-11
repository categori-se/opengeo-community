// Match the Esri credential boundary: memory only, outside Project definitions,
// drafts, browser storage, exports and API payloads.
export function createMapboxSession() {
  let token = "";
  return Object.freeze({
    get configured() { return Boolean(token); },
    configure(value) {
      const next = typeof value === "string" ? value.trim() : "";
      if (next.length > 4096 || !/^pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(next)) {
        throw new TypeError("Enter a public Mapbox token starting with pk. Secret tokens are not accepted.");
      }
      token = next;
    },
    clear() { token = ""; },
    mapOptions(options) {
      if (!token) throw new Error("mapbox_public_token_required");
      // Only the SDK constructor receives the value, never a shared definition.
      return {...options, accessToken: token};
    }
  });
}
