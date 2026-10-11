export const KML_NETWORK_LINK_LIMITS = Object.freeze({
  maximumHrefCharacters: 2_048,
  maximumTemplateCharacters: 2_048,
  maximumResponseBytes: 256 * 1024,
  minimumRefreshIntervalSeconds: 4,
  maximumRefreshIntervalSeconds: 86_400,
  maximumViewRefreshSeconds: 60,
  maximumViewBoundScale: 100,
  maximumConcurrentRequests: 4,
  maximumReceipts: 64,
  maximumApprovalSeconds: 86_400,
  maximumResponseFreshnessSeconds: 86_400,
  requestTimeoutMilliseconds: 10_000
});

const REFRESH_MODES = new Set(["onChange", "onInterval", "onExpire"]);
const VIEW_REFRESH_MODES = new Set(["never", "onStop", "onRequest", "onRegion"]);
const RESPONSE_MEDIA_TYPES = new Set([
  "application/vnd.google-earth.kml+xml",
  "application/vnd.google-earth.kmz",
  "application/xml",
  "text/xml"
]);
const VIEW_TOKENS = new Set([
  "bboxWest", "bboxSouth", "bboxEast", "bboxNorth",
  "lookatLon", "lookatLat", "lookatRange", "lookatTilt", "lookatHeading",
  "lookatTerrainLon", "lookatTerrainLat", "lookatTerrainAlt",
  "cameraLon", "cameraLat", "cameraAlt", "horizFov", "vertFov",
  "terrainEnabled", "clientVersion", "kmlVersion", "clientName", "language"
]);
const CREDENTIAL_QUERY_KEY = /^(?:authorization|token|access[_-]?token|id[_-]?token|api[_-]?key|apikey|key|signature|sig|credential|password|passwd|secret|session|x-amz-.+)$/i;
const UNSAFE_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example|arpa)$/i;

export function normalizeKmlNetworkLink(value) {
  if (!value || typeof value !== "object") throw networkLinkError("kml_network_link_invalid");
  const href = normalizeNetworkLinkHref(value.href);
  const refreshMode = value.refreshMode ?? "onChange";
  const viewRefreshMode = value.viewRefreshMode ?? "never";
  if (!REFRESH_MODES.has(refreshMode)) throw networkLinkError("kml_network_link_refresh_mode_invalid");
  if (!VIEW_REFRESH_MODES.has(viewRefreshMode)) throw networkLinkError("kml_network_link_view_refresh_mode_invalid");
  const refreshInterval = boundedNumber(
    value.refreshInterval ?? KML_NETWORK_LINK_LIMITS.minimumRefreshIntervalSeconds,
    KML_NETWORK_LINK_LIMITS.minimumRefreshIntervalSeconds,
    KML_NETWORK_LINK_LIMITS.maximumRefreshIntervalSeconds,
    "kml_network_link_refresh_interval_invalid"
  );
  const viewRefreshTime = boundedNumber(
    value.viewRefreshTime ?? 1,
    0,
    KML_NETWORK_LINK_LIMITS.maximumViewRefreshSeconds,
    "kml_network_link_view_refresh_time_invalid"
  );
  const viewBoundScale = boundedNumber(
    value.viewBoundScale ?? 1,
    0.01,
    KML_NETWORK_LINK_LIMITS.maximumViewBoundScale,
    "kml_network_link_view_bound_scale_invalid"
  );
  return {
    href,
    refreshMode,
    refreshInterval,
    viewRefreshMode,
    viewRefreshTime,
    viewBoundScale,
    viewFormat: normalizeTemplate(value.viewFormat, "kml_network_link_view_format_invalid"),
    httpQuery: normalizeTemplate(value.httpQuery, "kml_network_link_http_query_invalid")
  };
}

export function normalizeNetworkLinkHref(value) {
  if (typeof value !== "string" || !value.trim() || value.length > KML_NETWORK_LINK_LIMITS.maximumHrefCharacters) {
    throw networkLinkError("kml_network_link_href_invalid");
  }
  const href = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) {
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      throw networkLinkError("kml_network_link_href_invalid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== "443")) {
      throw networkLinkError("kml_network_link_href_unsafe");
    }
    const host = parsed.hostname.toLowerCase();
    if (!publicDnsName(host)) throw networkLinkError("kml_network_link_href_unsafe");
    rejectCredentialQuery(parsed.searchParams);
    return parsed.href;
  }
  if (!safeRelativeReference(href)) throw networkLinkError("kml_network_link_href_unsafe");
  return href;
}

export function authorizeKmlNetworkLink(link, {approvedAt, expiresAt} = {}) {
  const normalized = normalizeKmlNetworkLink(link);
  if (!isRemoteNetworkLink(normalized)) throw networkLinkError("kml_network_link_remote_href_required");
  const approved = normalizeInstant(approvedAt ?? new Date().toISOString(), "kml_network_link_approval_invalid");
  const expires = normalizeInstant(
    expiresAt ?? new Date(Date.parse(approved) + KML_NETWORK_LINK_LIMITS.maximumApprovalSeconds * 1_000).toISOString(),
    "kml_network_link_approval_invalid"
  );
  const lifetime = (Date.parse(expires) - Date.parse(approved)) / 1_000;
  if (lifetime <= 0 || lifetime > KML_NETWORK_LINK_LIMITS.maximumApprovalSeconds) {
    throw networkLinkError("kml_network_link_approval_invalid");
  }
  return {href: normalized.href, approvedAt: approved, expiresAt: expires, state: "approved"};
}

export function buildKmlNetworkLinkRequest(networkLink, approval, {
  linkId,
  reason = "manual",
  view = {},
  now = new Date().toISOString(),
  etag = null,
  lastModified = null
} = {}) {
  const link = normalizeKmlNetworkLink(networkLink);
  const requestedAt = normalizeInstant(now, "kml_network_link_request_invalid");
  if (!approval || approval.state !== "approved" || approval.href !== link.href
    || Date.parse(approval.approvedAt) > Date.parse(requestedAt)
    || Date.parse(approval.expiresAt) <= Date.parse(requestedAt)) {
    throw networkLinkError("kml_network_link_not_authorized");
  }
  if (!isRemoteNetworkLink(link)) throw networkLinkError("kml_network_link_remote_href_required");
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(linkId ?? "")) throw networkLinkError("kml_network_link_id_invalid");
  if (!["initial", "manual", "interval", "expire", "view-stop", "view-request", "region"].includes(reason)) {
    throw networkLinkError("kml_network_link_reason_invalid");
  }
  const requestUrl = expandKmlNetworkLinkUrl(link, view);
  return {
    schemaVersion: "1.0.0",
    linkId,
    reason,
    sourceHref: link.href,
    requestUrl,
    requestedAt,
    maximumBytes: KML_NETWORK_LINK_LIMITS.maximumResponseBytes,
    timeoutMilliseconds: KML_NETWORK_LINK_LIMITS.requestTimeoutMilliseconds,
    accept: [...RESPONSE_MEDIA_TYPES],
    conditional: {
      etag: boundedOptionalHeader(etag),
      lastModified: boundedOptionalHeader(lastModified)
    },
    transport: {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store"
    },
    securityContract: "public-https-dns-pinned-no-redirect-no-credentials-v1"
  };
}

export async function executeKmlNetworkLinkRequest(adapter, request, {
  controller = new AbortController(),
  timeoutMilliseconds = request?.timeoutMilliseconds
} = {}) {
  if (typeof adapter !== "function" || !request
    || request.securityContract !== "public-https-dns-pinned-no-redirect-no-credentials-v1"
    || request.transport?.credentials !== "omit"
    || request.transport?.redirect !== "error"
    || request.transport?.referrerPolicy !== "no-referrer"
    || request.transport?.cache !== "no-store") {
    throw networkLinkError("kml_network_link_request_invalid");
  }
  const timeout = boundedInteger(
    timeoutMilliseconds,
    1,
    request.timeoutMilliseconds,
    "kml_network_link_request_invalid"
  );
  if (controller.signal.aborted) throw abortError("kml_network_link_cancelled");
  let timer = null;
  let timedOut = false;
  let removeAbortListener = () => {};
  const boundary = new Promise((_resolve, reject) => {
    const onAbort = () => reject(timedOut
      ? networkLinkError("kml_network_link_timeout")
      : abortError("kml_network_link_cancelled"));
    controller.signal.addEventListener("abort", onAbort, {once: true});
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => adapter(request, {signal: controller.signal})),
      boundary
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    removeAbortListener();
  }
}

export function acceptKmlNetworkLinkReceipt(request, value) {
  if (!request || request.securityContract !== "public-https-dns-pinned-no-redirect-no-credentials-v1"
    || !value || typeof value !== "object") throw networkLinkError("kml_network_link_receipt_invalid");
  const fetchedAt = normalizeInstant(value.fetchedAt, "kml_network_link_receipt_invalid");
  const requestedAtMs = Date.parse(normalizeInstant(request.requestedAt, "kml_network_link_receipt_invalid"));
  const fetchedAtMs = Date.parse(fetchedAt);
  const mediaType = String(value.mediaType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (value.requestUrl !== request.requestUrl || value.finalUrl !== request.requestUrl
    || ![200, 304].includes(value.status) || value.redirects !== 0
    || value.dnsPinned !== true || value.allAddressesPublic !== true || value.tlsVerified !== true
    || value.credentialsSent !== false
    || fetchedAtMs < requestedAtMs || fetchedAtMs > requestedAtMs + request.timeoutMilliseconds
    || !RESPONSE_MEDIA_TYPES.has(mediaType)) throw networkLinkError("kml_network_link_receipt_invalid");
  const byteLength = boundedInteger(value.byteLength, 0, request.maximumBytes, "kml_network_link_receipt_invalid");
  const bodyText = typeof value.bodyText === "string" ? value.bodyText : null;
  const bodyBase64 = typeof value.bodyBase64 === "string" ? value.bodyBase64 : null;
  if (value.status === 304) {
    if (byteLength !== 0 || bodyText !== null || bodyBase64 !== null) throw networkLinkError("kml_network_link_receipt_invalid");
  } else {
    if ((bodyText === null) === (bodyBase64 === null)) throw networkLinkError("kml_network_link_receipt_invalid");
    const actualBytes = bodyText !== null ? new TextEncoder().encode(bodyText).byteLength : base64ByteLength(bodyBase64);
    if (actualBytes !== byteLength) throw networkLinkError("kml_network_link_receipt_invalid");
    if (mediaType === "application/vnd.google-earth.kmz" && bodyBase64 === null) throw networkLinkError("kml_network_link_receipt_invalid");
    if (mediaType !== "application/vnd.google-earth.kmz" && bodyText === null) throw networkLinkError("kml_network_link_receipt_invalid");
  }
  const expiresAt = value.expiresAt === null || value.expiresAt === undefined
    ? null
    : normalizeInstant(value.expiresAt, "kml_network_link_receipt_invalid");
  if (expiresAt && (Date.parse(expiresAt) <= fetchedAtMs
    || Date.parse(expiresAt) > fetchedAtMs + KML_NETWORK_LINK_LIMITS.maximumResponseFreshnessSeconds * 1_000)) {
    throw networkLinkError("kml_network_link_receipt_invalid");
  }
  return {
    linkId: request.linkId,
    reason: request.reason,
    sourceHref: request.sourceHref,
    requestUrl: request.requestUrl,
    fetchedAt,
    status: value.status,
    mediaType,
    byteLength,
    etag: boundedOptionalHeader(value.etag),
    lastModified: boundedOptionalHeader(value.lastModified),
    expiresAt,
    bodyText,
    bodyBase64,
    security: {
      dnsPinned: true,
      allAddressesPublic: true,
      tlsVerified: true,
      redirects: 0,
      credentialsSent: false
    }
  };
}

export function kmlNetworkLinkRefreshDecision(networkLink, runtime = {}, {
  reason,
  now = new Date().toISOString(),
  regionActive = true,
  previousRegionActive = runtime.regionActive ?? false,
  viewStoppedAt = null
} = {}) {
  const link = normalizeKmlNetworkLink(networkLink);
  const nowMs = Date.parse(normalizeInstant(now, "kml_network_link_refresh_decision_invalid"));
  if (runtime.inFlight === true) return {due: false, dueAt: null, reason: "in-flight"};
  if (reason === "manual") return {due: true, dueAt: new Date(nowMs).toISOString(), reason};
  if (reason === "initial" && runtime.contentAvailable !== true) {
    return {due: true, dueAt: new Date(nowMs).toISOString(), reason};
  }
  if (reason === "interval" && link.refreshMode === "onInterval" && runtime.lastSuccessAt) {
    const dueMs = Date.parse(runtime.lastSuccessAt) + link.refreshInterval * 1_000;
    return {due: nowMs >= dueMs, dueAt: new Date(dueMs).toISOString(), reason};
  }
  if (reason === "expire" && link.refreshMode === "onExpire" && runtime.expiresAt) {
    const dueMs = Date.parse(runtime.expiresAt);
    return {due: Number.isFinite(dueMs) && nowMs >= dueMs, dueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null, reason};
  }
  if (reason === "view-stop" && link.viewRefreshMode === "onStop" && viewStoppedAt) {
    const dueMs = Date.parse(viewStoppedAt) + link.viewRefreshTime * 1_000;
    return {due: Number.isFinite(dueMs) && nowMs >= dueMs, dueAt: Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : null, reason};
  }
  if (reason === "view-request" && link.viewRefreshMode === "onRequest") {
    return {due: true, dueAt: new Date(nowMs).toISOString(), reason};
  }
  if (reason === "region" && link.viewRefreshMode === "onRegion") {
    return {due: regionActive && !previousRegionActive, dueAt: regionActive && !previousRegionActive ? new Date(nowMs).toISOString() : null, reason};
  }
  return {due: false, dueAt: null, reason: "mode-mismatch"};
}

export function normalizeKmlNetworkLinkState(value) {
  if (value === null || value === undefined) return {schemaVersion: "1.0.0", receipts: []};
  if (!value || value.schemaVersion !== "1.0.0" || !Array.isArray(value.receipts)
    || value.receipts.length > KML_NETWORK_LINK_LIMITS.maximumReceipts) throw networkLinkError("kml_network_link_state_invalid");
  return {
    schemaVersion: "1.0.0",
    receipts: value.receipts.map((item) => ({
      linkId: boundedId(item.linkId),
      reason: boundedText(item.reason, 32, "kml_network_link_state_invalid"),
      sourceHref: normalizeNetworkLinkHref(item.sourceHref),
      requestUrl: normalizeNetworkLinkHref(item.requestUrl),
      fetchedAt: normalizeInstant(item.fetchedAt, "kml_network_link_state_invalid"),
      status: [200, 304].includes(item.status) ? item.status : invalid("kml_network_link_state_invalid"),
      mediaType: RESPONSE_MEDIA_TYPES.has(item.mediaType) ? item.mediaType : invalid("kml_network_link_state_invalid"),
      byteLength: boundedInteger(item.byteLength, 0, KML_NETWORK_LINK_LIMITS.maximumResponseBytes, "kml_network_link_state_invalid"),
      etag: boundedOptionalHeader(item.etag),
      lastModified: boundedOptionalHeader(item.lastModified),
      expiresAt: item.expiresAt ? normalizeInstant(item.expiresAt, "kml_network_link_state_invalid") : null,
      content: normalizeReceiptContent(item.content),
      securityContract: "public-https-dns-pinned-no-redirect-no-credentials-v1"
    }))
  };
}

export function kmlNetworkLinkStateForProject(project) {
  try {
    return normalizeKmlNetworkLinkState(project?.kmlNetworkLinkState);
  } catch {
    return {schemaVersion: "1.0.0", receipts: []};
  }
}

export function kmlNetworkLinkStateForSave(value) {
  return normalizeKmlNetworkLinkState(value);
}

export function receiptForKmlNetworkLinkState(receipt) {
  return normalizeKmlNetworkLinkState({
    schemaVersion: "1.0.0",
    receipts: [{...receipt, securityContract: "public-https-dns-pinned-no-redirect-no-credentials-v1"}]
  }).receipts[0];
}

export function isRemoteNetworkLink(value) {
  return typeof value?.href === "string" && value.href.startsWith("https://");
}

function expandKmlNetworkLinkUrl(link, view) {
  const target = new URL(link.href);
  const templates = [
    ...(link.viewRefreshMode === "never" ? [] : [[link.viewFormat, scaleKmlNetworkLinkView(view, link.viewBoundScale)]]),
    [link.httpQuery, view]
  ];
  for (const [template, templateView] of templates) {
    if (!template) continue;
    const expanded = template.replace(/\[([A-Za-z][A-Za-z0-9]*)\]/g, (_match, token) => {
      if (!VIEW_TOKENS.has(token)) throw networkLinkError("kml_network_link_template_token_invalid");
      return encodeURIComponent(viewValue(token, templateView));
    });
    const params = new URLSearchParams(expanded.replace(/^\?/, ""));
    rejectCredentialQuery(params);
    for (const [key, value] of params) target.searchParams.append(key, value);
  }
  rejectCredentialQuery(target.searchParams);
  if (target.href.length > KML_NETWORK_LINK_LIMITS.maximumHrefCharacters) throw networkLinkError("kml_network_link_request_url_too_long");
  return target.href;
}

export function scaleKmlNetworkLinkView(view, scale) {
  const factor = boundedNumber(scale, 0.01, KML_NETWORK_LINK_LIMITS.maximumViewBoundScale, "kml_network_link_view_invalid");
  const west = boundedViewCoordinate(view?.west ?? -180, -540, 540);
  const east = boundedViewCoordinate(view?.east ?? 180, -540, 540);
  const south = boundedViewCoordinate(view?.south ?? -90, -90, 90);
  const north = boundedViewCoordinate(view?.north ?? 90, -90, 90);
  if (north < south) throw networkLinkError("kml_network_link_view_invalid");
  let unwrappedEast = east;
  while (unwrappedEast < west) unwrappedEast += 360;
  const longitudeSpan = Math.min(360, unwrappedEast - west);
  const longitudeCenter = west + longitudeSpan / 2;
  const scaledLongitudeSpan = Math.min(360, longitudeSpan * factor);
  const latitudeCenter = south + (north - south) / 2;
  const scaledLatitudeSpan = Math.min(180, (north - south) * factor);
  return {
    ...(view && typeof view === "object" ? view : {}),
    west: scaledLongitudeSpan === 360 ? -180 : longitudeCenter - scaledLongitudeSpan / 2,
    east: scaledLongitudeSpan === 360 ? 180 : longitudeCenter + scaledLongitudeSpan / 2,
    south: Math.max(-90, latitudeCenter - scaledLatitudeSpan / 2),
    north: Math.min(90, latitudeCenter + scaledLatitudeSpan / 2)
  };
}

function viewValue(token, view) {
  const values = {
    bboxWest: view.west,
    bboxSouth: view.south,
    bboxEast: view.east,
    bboxNorth: view.north,
    lookatLon: view.longitude,
    lookatLat: view.latitude,
    lookatRange: view.range ?? 0,
    lookatTilt: view.tilt ?? view.pitch ?? 0,
    lookatHeading: view.heading ?? view.bearing ?? 0,
    lookatTerrainLon: view.longitude,
    lookatTerrainLat: view.latitude,
    lookatTerrainAlt: view.terrainAltitude ?? 0,
    cameraLon: view.longitude,
    cameraLat: view.latitude,
    cameraAlt: view.altitude ?? 0,
    horizFov: view.horizontalFov ?? 0,
    vertFov: view.verticalFov ?? 0,
    terrainEnabled: view.terrainEnabled ? 1 : 0,
    clientVersion: "opengeo-1",
    kmlVersion: "2.2",
    clientName: "OpenGeo",
    language: typeof view.language === "string" ? view.language.slice(0, 35) : "en"
  };
  const value = values[token];
  if (typeof value === "number" && !Number.isFinite(value)) throw networkLinkError("kml_network_link_view_invalid");
  return value ?? "";
}

function normalizeTemplate(value, code) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > KML_NETWORK_LINK_LIMITS.maximumTemplateCharacters
    || /[\u0000-\u001f\u007f\\#]/.test(value)) throw networkLinkError(code);
  for (const match of value.matchAll(/\[([^\]]+)\]/g)) if (!VIEW_TOKENS.has(match[1])) throw networkLinkError("kml_network_link_template_token_invalid");
  const params = new URLSearchParams(value.replace(/^\?/, ""));
  rejectCredentialQuery(params);
  return value;
}

function publicDnsName(host) {
  return host.length <= 253 && host.includes(".") && !UNSAFE_HOST_SUFFIX.test(host)
    && !host.includes(":") && !/^\d+(?:\.\d+){3}$/.test(host)
    && host.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
}

function safeRelativeReference(value) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !/%2e|%2f|%5c/i.test(part));
}

function rejectCredentialQuery(params) {
  for (const key of params.keys()) if (CREDENTIAL_QUERY_KEY.test(key)) throw networkLinkError("kml_network_link_credentials_rejected");
}

function boundedNumber(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw networkLinkError(code);
  return number;
}

function boundedInteger(value, minimum, maximum, code) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw networkLinkError(code);
  return number;
}

function boundedViewCoordinate(value, minimum, maximum) {
  return boundedNumber(value, minimum, maximum, "kml_network_link_view_invalid");
}

function boundedOptionalHeader(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || /[\r\n\u0000]/.test(value)) throw networkLinkError("kml_network_link_header_invalid");
  return value;
}

function boundedId(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/.test(value)) throw networkLinkError("kml_network_link_state_invalid");
  return value;
}

function boundedText(value, maximum, code) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw networkLinkError(code);
  return value;
}

function normalizeReceiptContent(value) {
  if (!value || typeof value !== "object"
    || !["pass", "pass_with_declared_losses", "not_modified"].includes(value.result)) {
    throw networkLinkError("kml_network_link_state_invalid");
  }
  return {
    result: value.result,
    featureCount: boundedInteger(value.featureCount, 0, 1_000, "kml_network_link_state_invalid"),
    declaredLossCount: boundedInteger(value.declaredLossCount, 0, 1_000, "kml_network_link_state_invalid")
  };
}

function normalizeInstant(value, code) {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) throw networkLinkError(code);
  return new Date(value).toISOString();
}

function base64ByteLength(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw networkLinkError("kml_network_link_receipt_invalid");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function invalid(code) {
  throw networkLinkError(code);
}

function networkLinkError(code) {
  return Object.assign(new Error(code), {code});
}

function abortError(code) {
  return Object.assign(new Error(code), {name: "AbortError", code});
}
