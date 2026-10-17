/** Trusted deployment configuration, independent of a capability response URL. */
export const DEFAULT_PUBLICATION_PREVIEW_ORIGINS = Object.freeze({
  local_only: "https://preview.studio.opengeo.tools",
  public_maps_v1: "https://maps-preview.studio.opengeo.tools"
});

export function resolvePublicationPreviewOrigins(configured, studioOrigin = globalThis.location?.origin) {
  if (configured !== undefined && (!configured || typeof configured !== "object" || Array.isArray(configured)
    || Object.keys(configured).some(key => !Object.hasOwn(DEFAULT_PUBLICATION_PREVIEW_ORIGINS, key)))) {
    throw new TypeError("Publication preview origins are invalid");
  }
  let studio;
  if (studioOrigin !== undefined) {
    studio = new URL(studioOrigin);
    if (studio.origin !== studioOrigin || studio.username || studio.password || studio.pathname !== "/"
      || studio.search || studio.hash || !["https:", "http:"].includes(studio.protocol)) {
      throw new TypeError("Studio origin is invalid");
    }
  } else if (configured !== undefined) throw new TypeError("Configured previews require the Studio origin");
  const result = {...DEFAULT_PUBLICATION_PREVIEW_ORIGINS, ...configured};
  for (const origin of Object.values(result)) {
    if (typeof origin !== "string" || origin.length > 2048) throw new TypeError("Publication preview origin is invalid");
    const preview = new URL(origin);
    const local = preview.protocol === "http:" && preview.hostname === "127.0.0.1" && Boolean(preview.port)
      && studio?.protocol === "http:" && studio.hostname === "127.0.0.1" && preview.port !== studio.port;
    if (preview.origin !== origin || preview.username || preview.password || preview.pathname !== "/" || preview.search || preview.hash
      || preview.origin === studio?.origin || (preview.protocol !== "https:" && !local)) {
      throw new TypeError("Publication preview origin must be a separate canonical HTTPS origin or explicit local loopback port");
    }
  }
  if (result.local_only === result.public_maps_v1) {
    throw new TypeError("Publication preview profiles require distinct origins");
  }
  return Object.freeze(result);
}
