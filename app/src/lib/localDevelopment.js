const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localFixtureWorkspaceHref(
  locationHref = globalThis.location?.href
) {
  if (typeof locationHref !== "string" || !locationHref) return null;

  let url;
  try {
    url = new URL(locationHref);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return null;
  }

  return "/workspaces?adapter=fixture";
}
