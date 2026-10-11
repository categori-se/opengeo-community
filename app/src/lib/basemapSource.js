const PROVIDER_HOST = /(^|\.)(?:protomaps\.com|cartocdn\.com|mapbox\.com)$/i;

export function customBasemapDefinition({basemapId, sourceType, title, url, attribution}) {
  const kind = sourceType === "raster" ? "raster" : sourceType === "maplibre-style"
    ? "maplibre-style"
    : null;
  const name = boundedText(title, "custom basemap name", 200);
  const credit = boundedText(attribution, "custom basemap attribution", 1000);
  const sourceUrl = publicBasemapUrl(url, kind);
  if (typeof basemapId !== "string" || !/^custom-[0-9a-f-]{36}$/i.test(basemapId)) {
    throw new TypeError("custom basemap id is invalid");
  }
  return {
    basemapId,
    title: name,
    section: "Custom",
    kind,
    description: new URL(sourceUrl).hostname,
    ...(kind === "maplibre-style" ? {styleUrl: sourceUrl} : {url: sourceUrl}),
    attribution: credit
  };
}

export function publicBasemapUrl(value, sourceType) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    !["maplibre-style", "raster"].includes(sourceType)
    || !raw
    || raw.length > 2048
    || /[\u0000-\u001f\u007f\\]/.test(raw)
  ) {
    throw new TypeError("custom basemap URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new TypeError("custom basemap URL is invalid", {cause});
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
    || parsed.search
    || parsed.hash
    || !hostname
    || blockedHostname(hostname)
    || PROVIDER_HOST.test(hostname)
  ) {
    throw new TypeError("custom basemap URL is not an allowed public source");
  }
  if (sourceType === "raster") {
    const placeholders = [...raw.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    if (
      placeholders.length !== 3
      || new Set(placeholders).size !== 3
      || !["z", "x", "y"].every((name) => placeholders.includes(name))
    ) {
      throw new TypeError("custom XYZ URL placeholders are invalid");
    }
  } else if (/[{}]/.test(raw)) {
    throw new TypeError("custom style URL may not contain placeholders");
  }
  return sourceType === "raster" ? raw : parsed.href;
}

function blockedHostname(hostname) {
  if (
    hostname === "localhost"
    || hostname === "localhost.localdomain"
    || [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix))
    || hostname.includes(":")
  ) return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return true;
}

function boundedText(value, label, maximum) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}
