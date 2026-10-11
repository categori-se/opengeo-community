const STYLE_KINDS = new Set(["maplibre-style", "provider-style"]);
const RASTER_KINDS = new Set(["raster", "provider-raster", "governed-raster"]);
const RENDERED_SOURCE_TYPES = new Set(["raster", "raster-dem", "vector"]);
const RESOURCE_KINDS = new Set(["style", "source", "tile", "glyph", "sprite", "coverage", "unknown"]);
const ESCALATING_RESOURCE_KINDS = new Set(["style", "source", "tile", "unknown"]);
const OPTIONAL_RESOURCE_KINDS = new Set(["glyph", "sprite", "coverage"]);

export const BASEMAP_RUNTIME_LIMITS = Object.freeze({
  failureThreshold: 3,
  failureWindowMilliseconds: 10_000
});

function normalizedResourceKind(kind) {
  const normalized = typeof kind === "string" ? kind.toLowerCase() : "";
  const aliases = {
    glyphs: "glyph",
    spriteimage: "sprite",
    spritejson: "sprite"
  };
  const candidate = aliases[normalized] ?? normalized;
  return RESOURCE_KINDS.has(candidate) ? candidate : "unknown";
}

function normalizedUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, "https://opengeo.invalid");
    return `${url.origin}${url.pathname}`.replaceAll("%7B", "{").replaceAll("%7D", "}");
  } catch {
    return value.split(/[?#]/, 1)[0] || null;
  }
}

function resourceTemplateMatches(url, template) {
  const normalized = normalizedUrl(url);
  const normalizedTemplate = normalizedUrl(template);
  if (!normalized || !normalizedTemplate) return false;
  const placeholder = normalizedTemplate.search(/\{/);
  if (placeholder >= 0) return normalized.startsWith(normalizedTemplate.slice(0, placeholder));
  return normalized === normalizedTemplate || normalized.startsWith(`${normalizedTemplate}.`);
}

function styleSprites(style) {
  if (typeof style?.sprite === "string") return [style.sprite];
  if (!Array.isArray(style?.sprite)) return [];
  return style.sprite.map((entry) => entry?.url).filter((url) => typeof url === "string");
}

export function basemapRuntimeIssueFromError({event, style} = {}) {
  const explicitKind = normalizedResourceKind(event?.resourceType ?? event?.resourceKind);
  if (explicitKind !== "unknown") return Object.freeze({kind: explicitKind});
  if (event?.tile) return Object.freeze({kind: "tile"});
  if (event?.sourceId) return Object.freeze({kind: "source"});

  const errorUrl = event?.error?.url;
  if (resourceTemplateMatches(errorUrl, style?.glyphs)) return Object.freeze({kind: "glyph"});
  if (styleSprites(style).some((sprite) => resourceTemplateMatches(errorUrl, sprite))) {
    return Object.freeze({kind: "sprite"});
  }
  if (event?.dataType === "style") return Object.freeze({kind: "style"});
  return Object.freeze({kind: "unknown"});
}

export function basemapRuntimeIssueBlocksActivation(issue) {
  return !OPTIONAL_RESOURCE_KINDS.has(normalizedResourceKind(issue?.kind));
}

export function basemapRuntimeErrorApplies({
  basemap,
  event,
  managedSourceIds = [],
  networkAllowed = true
} = {}) {
  if (!networkAllowed || !basemap) return false;
  const sourceId = typeof event?.sourceId === "string" ? event.sourceId : null;
  const managed = managedSourceIds instanceof Set
    ? managedSourceIds
    : new Set(managedSourceIds);
  if (sourceId && managed.has(sourceId)) return false;
  if (RASTER_KINDS.has(basemap.kind)) return sourceId === "basemap";
  if (STYLE_KINDS.has(basemap.kind)) return true;
  return false;
}

function finiteZoom(value) {
  return Number.isFinite(value) ? value : null;
}

function plainBounds(value) {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) {
    return {west: value[0], south: value[1], east: value[2], north: value[3]};
  }
  if (!value || typeof value !== "object") return null;
  const west = finiteZoom(value.west ?? value._sw?.lng);
  const south = finiteZoom(value.south ?? value._sw?.lat);
  const east = finiteZoom(value.east ?? value._ne?.lng);
  const north = finiteZoom(value.north ?? value._ne?.lat);
  return [west, south, east, north].every(Number.isFinite)
    ? {west, south, east, north}
    : null;
}

function normalizedLongitude(value) {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function longitudeSegments({west, east}) {
  const span = east >= west ? east - west : east + 360 - west;
  if (span >= 360) return [[-180, 180]];
  const normalizedWest = normalizedLongitude(west);
  const normalizedEast = normalizedLongitude(east);
  return normalizedWest <= normalizedEast
    ? [[normalizedWest, normalizedEast]]
    : [[normalizedWest, 180], [-180, normalizedEast]];
}

function boundsIntersect(left, right) {
  if (left.north < right.south || right.north < left.south) return false;
  return longitudeSegments(left).some(([leftWest, leftEast]) => (
    longitudeSegments(right).some(([rightWest, rightEast]) => (
      leftEast >= rightWest && rightEast >= leftWest
    ))
  ));
}

function aggregateCoverageIssue(reason, affected, total) {
  return Object.freeze({kind: "coverage", reason, affected, total});
}

export function basemapCoverageIssues({zoom, viewportBounds, sources = []} = {}) {
  const currentZoom = finiteZoom(zoom);
  const viewport = plainBounds(viewportBounds);
  const candidates = sources.filter((source) => RENDERED_SOURCE_TYPES.has(source?.type));
  if (!candidates.length) return Object.freeze([]);

  let belowMinimum = 0;
  let aboveMaximum = 0;
  let outsideExtent = 0;
  for (const source of candidates) {
    const minimum = finiteZoom(source.minzoom ?? source.minZoom);
    const maximum = finiteZoom(source.maxzoom ?? source.maxZoom);
    const bounds = plainBounds(source.bounds);
    if (currentZoom !== null && minimum !== null && currentZoom < minimum) belowMinimum += 1;
    if (currentZoom !== null && maximum !== null && currentZoom > maximum) aboveMaximum += 1;
    if (viewport && bounds && !boundsIntersect(viewport, bounds)) outsideExtent += 1;
  }

  const issues = [];
  if (outsideExtent) issues.push(aggregateCoverageIssue("outside-extent", outsideExtent, candidates.length));
  if (belowMinimum) issues.push(aggregateCoverageIssue("below-minimum-zoom", belowMinimum, candidates.length));
  if (aboveMaximum) issues.push(aggregateCoverageIssue("above-maximum-detail", aboveMaximum, candidates.length));
  return Object.freeze(issues);
}

function coverageSignature(issues) {
  return issues
    .map(({reason, affected, total}) => `${reason}:${affected}:${total}`)
    .sort()
    .join("|");
}

function issueCounts(failures, coverageIssues) {
  const counts = Object.fromEntries([...RESOURCE_KINDS].map((kind) => [kind, 0]));
  for (const failure of failures) counts[failure.kind] += 1;
  counts.coverage = coverageIssues.length;
  return counts;
}

export function createBasemapRuntimeHealth({
  basemapId = null,
  now = () => Date.now()
} = {}) {
  let activeBasemapId = basemapId;
  let state = "monitoring";
  let failures = [];
  let coverageIssues = [];
  let detectedAt = null;
  let reason = null;

  const currentTime = () => {
    const value = now();
    return Number.isFinite(value) ? value : null;
  };

  const prune = (at) => {
    if (!Number.isFinite(at)) return;
    failures = failures.filter(
      ({at: failureAt}) => at - failureAt <= BASEMAP_RUNTIME_LIMITS.failureWindowMilliseconds
    );
  };

  const snapshot = () => {
    const counts = issueCounts(failures, coverageIssues);
    return Object.freeze({
      state,
      basemapId: activeBasemapId,
      failureCount: failures.length,
      issueCounts: Object.freeze(counts),
      issueKinds: Object.freeze(Object.keys(counts).filter((kind) => counts[kind] > 0)),
      coverageIssues: Object.freeze(coverageIssues.map((issue) => Object.freeze({...issue}))),
      impact: state === "outage" || reason === "activation-timeout" || reason === "retry-check-failed"
        ? "outage"
        : state === "limited"
          ? "notice"
          : failures.length || coverageIssues.length
            ? "partial"
            : "none",
      detectedAt,
      reason
    });
  };

  return Object.freeze({
    snapshot,
    begin(nextBasemapId, {recovery = false} = {}) {
      activeBasemapId = nextBasemapId;
      state = recovery ? "retrying" : "monitoring";
      failures = [];
      coverageIssues = [];
      detectedAt = null;
      reason = null;
      return snapshot();
    },
    recordFailure(nextBasemapId, issue = {kind: "source"}) {
      if (!nextBasemapId || nextBasemapId !== activeBasemapId) return snapshot();
      if (state === "outage") return snapshot();
      const at = currentTime();
      if (at === null) return snapshot();
      prune(at);
      failures.push({at, kind: normalizedResourceKind(issue?.kind)});
      const escalatingFailures = failures.filter(({kind}) => ESCALATING_RESOURCE_KINDS.has(kind));
      if (state !== "retained" && escalatingFailures.length >= BASEMAP_RUNTIME_LIMITS.failureThreshold) {
        state = "outage";
        detectedAt = new Date(at).toISOString();
        reason = escalatingFailures.every(({kind}) => kind === "tile")
          ? "repeated-tile-errors"
          : "repeated-errors";
      } else if (!["retrying", "retained"].includes(state)) {
        state = "incomplete";
        detectedAt ??= new Date(at).toISOString();
        reason = "partial-resource";
      }
      return snapshot();
    },
    recordCoverage(nextBasemapId, nextIssues = []) {
      if (!nextBasemapId || nextBasemapId !== activeBasemapId) return snapshot();
      const normalized = nextIssues
        .filter((issue) => issue?.kind === "coverage" && typeof issue.reason === "string")
        .map((issue) => ({
          kind: "coverage",
          reason: issue.reason,
          affected: Number.isInteger(issue.affected) ? issue.affected : 1,
          total: Number.isInteger(issue.total) ? issue.total : 1
        }));
      if (coverageSignature(normalized) === coverageSignature(coverageIssues)) return snapshot();
      coverageIssues = normalized;
      if (coverageIssues.length && !failures.length && ["monitoring", "healthy", "incomplete", "limited"].includes(state)) {
        state = coverageIssues.every(({reason: coverageReason}) => coverageReason === "above-maximum-detail")
          ? "limited"
          : "incomplete";
        detectedAt ??= new Date(currentTime() ?? 0).toISOString();
        reason = "coverage-limit";
      } else if (!coverageIssues.length && !failures.length && ["incomplete", "limited", "retained"].includes(state)) {
        state = "healthy";
        detectedAt = null;
        reason = null;
      }
      return snapshot();
    },
    recordUnavailable(nextBasemapId, unavailableReason = "activation-timeout") {
      if (!nextBasemapId || nextBasemapId !== activeBasemapId) return snapshot();
      const at = currentTime();
      state = "outage";
      failures = Array.from(
        {length: BASEMAP_RUNTIME_LIMITS.failureThreshold},
        () => ({at: at ?? 0, kind: "source"})
      );
      detectedAt = new Date(at ?? 0).toISOString();
      reason = unavailableReason;
      return snapshot();
    },
    recordReady(nextBasemapId) {
      if (!nextBasemapId || nextBasemapId !== activeBasemapId) return snapshot();
      if (state === "retrying") {
        prune(currentTime());
        const escalatingFailures = failures.filter(({kind}) => ESCALATING_RESOURCE_KINDS.has(kind));
        if (escalatingFailures.length >= BASEMAP_RUNTIME_LIMITS.failureThreshold) {
          state = "outage";
          detectedAt ??= new Date(currentTime() ?? 0).toISOString();
          reason = "retry-render-error";
        } else if (failures.length || coverageIssues.length) {
          state = "incomplete";
          detectedAt ??= new Date(currentTime() ?? 0).toISOString();
          reason = "partial-resource";
        } else {
          state = "healthy";
          detectedAt = null;
          reason = null;
        }
        return snapshot();
      }
      if (state === "monitoring") {
        state = failures.length || coverageIssues.length ? "incomplete" : "healthy";
        if (state === "healthy") {
          detectedAt = null;
          reason = null;
        }
      }
      return snapshot();
    },
    retain(nextBasemapId) {
      if (nextBasemapId === activeBasemapId && ["outage", "incomplete", "limited"].includes(state)) state = "retained";
      return snapshot();
    },
    retry(nextBasemapId) {
      if (nextBasemapId === activeBasemapId && ["outage", "incomplete", "retained"].includes(state)) {
        state = "retrying";
        failures = [];
        coverageIssues = [];
        reason = null;
      }
      return snapshot();
    },
    retryFailed(nextBasemapId) {
      if (nextBasemapId === activeBasemapId && state === "retrying") {
        state = "outage";
        failures = Array.from(
          {length: BASEMAP_RUNTIME_LIMITS.failureThreshold},
          () => ({at: currentTime() ?? 0, kind: "source"})
        );
        detectedAt = new Date(currentTime() ?? 0).toISOString();
        reason = "retry-check-failed";
      }
      return snapshot();
    }
  });
}

function affectedSources(issue) {
  if (issue.affected === issue.total) return "All background sources";
  return `${issue.affected} of ${issue.total} background sources`;
}

export function basemapRuntimeIssueDetails(runtime) {
  const counts = runtime?.issueCounts ?? {};
  const details = [];
  if (counts.style) details.push("Map design — the style definition could not be loaded.");
  if (counts.source) details.push(`Map source — ${counts.source} recent source request${counts.source === 1 ? "" : "s"} failed.`);
  if (counts.tile) details.push(`Map tiles — ${counts.tile} recent tile request${counts.tile === 1 ? "" : "s"} failed; areas already loaded can remain visible.`);
  if (counts.sprite) details.push("Map symbols — the style symbol sheet is unavailable, so some icons may be missing.");
  if (counts.glyph) details.push("Labels — a requested font range is unavailable; supported characters can still render locally.");
  for (const issue of runtime?.coverageIssues ?? []) {
    if (issue.reason === "outside-extent") {
      details.push(`Coverage — ${affectedSources(issue)} do not cover the current view.`);
    } else if (issue.reason === "below-minimum-zoom") {
      details.push(`Coverage — ${affectedSources(issue)} begin at a closer zoom.`);
    } else if (issue.reason === "above-maximum-detail") {
      details.push(`Detail — ${affectedSources(issue)} have reached their published maximum detail and may appear enlarged.`);
    }
  }
  if (counts.unknown) details.push("Background resource — a renderer request failed, but the resource type was not reported.");
  return Object.freeze(details);
}

export function basemapRuntimeMessage({title = "The background", runtime} = {}) {
  const failureCount = runtime?.failureCount ?? 0;
  switch (runtime?.state) {
    case "outage":
      if (runtime?.reason === "retry-check-failed") {
        return `${title} did not pass the retry check. The current map, project layers, map position, and saved basemap remain unchanged.`;
      }
      if (runtime?.reason === "activation-timeout") {
        return `${title} did not settle in the active map within eight seconds. Project layers, map position, and the saved basemap remain unchanged.`;
      }
      if (runtime?.reason === "repeated-tile-errors") {
        return `${title} has ${runtime.issueCounts?.tile ?? failureCount} recent map-tile failures. Project layers and map position remain available, and the saved basemap has not changed.`;
      }
      return `${title} stopped loading after ${failureCount} recent background-source errors. Project layers and map position remain available, and the saved basemap has not changed.`;
    case "incomplete":
      return `${title} is partly available. OpenGeo Studio identified the affected background resources without changing project layers, map position, or the saved basemap.`;
    case "limited":
      return `${title} is still visible, but the current zoom is beyond its published detail. Project layers, map position, and the saved basemap remain unchanged.`;
    case "retained":
      return `${title} remains selected. Its background may be incomplete; project layers, map position, and the saved basemap remain unchanged.`;
    case "retrying":
      return `Checking ${title} again while the current map, project layers, and saved basemap remain unchanged.`;
    case "healthy":
      return `${title} is loading normally in this browser session.`;
    default:
      return `Monitoring ${title} after activation.`;
  }
}
